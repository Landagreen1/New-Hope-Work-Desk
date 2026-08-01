// Unit tests for the read routes' parameter parsing.
//
// Feature: time-attendance-ui-redesign, task 7.2
//
// A `RecordQuery` is a conjunction, so the only dangerous parsing mistake is one
// that widens the result set. The tests are organised around that:
//
//   1. A value the module does not accept is reported, not dropped. A dropped
//      `saved_filter` answers with every record in the range and looks like a
//      filter that matched everything.
//   2. An absent filter produces an absent key, never an empty list. An empty
//      list is an empty intersection, which matches nothing.
//   3. A metric drill-down conjoins the metric's own scope, so the rows a caller
//      reaches are the rows the figure was computed over.
//
// Requirements: 12.3, 12.17, 13.2, 13.5, 20.8, 21.15

import { describe, expect, it } from 'vitest';

import { SAVED_FILTER_IDS, matchesRecordQuery, recordQueryForMetric } from '../../domain/attendance';
import type { DailyAttendanceRecord } from '../../domain/types';
import { ApiRequestError } from '../api-response';
import {
  DEPARTMENTS,
  DERIVED_STATUSES,
  EXCEPTION_CODES,
  optionalDate,
  optionalProfileId,
  parseMetricQuery,
  parseRecordQuery,
  requiredDate,
  requiredDateRange,
  requiredIdentifier,
} from '../request-query';

function params(search: string): URLSearchParams {
  return new URL(`https://desk.test/api/attendance/records${search}`).searchParams;
}

/** The `ApiRequestError` a parse threw, or a failure if it did not throw. */
function rejection(parse: () => unknown): ApiRequestError {
  try {
    parse();
  } catch (error) {
    if (error instanceof ApiRequestError) return error;
    throw error;
  }
  throw new Error('expected the parse to be rejected');
}

// ─── The accepted vocabularies ───────────────────────────────────────────────

describe('the accepted vocabularies', () => {
  it('reads the twelve statuses off the status rule matrix', () => {
    expect(DERIVED_STATUSES).toHaveLength(12);
    expect(DERIVED_STATUSES).toContain('needs_review');
    expect(DERIVED_STATUSES).toContain('approved_time_off');
  });

  it('reads the exception codes off the exception rule table', () => {
    expect(EXCEPTION_CODES).toContain('missing_clock_out');
    expect(EXCEPTION_CODES).toContain('schedule_without_clock');
    // The table carries two rules for one code; the vocabulary is distinct.
    expect(new Set(EXCEPTION_CODES).size).toBe(EXCEPTION_CODES.length);
  });

  it('reads the departments through the canonical role mapping', () => {
    expect([...DEPARTMENTS].sort()).toEqual([
      'commercial',
      'customer_service',
      'management',
      'sales',
    ]);
  });
});

// ─── Filters that are accepted ───────────────────────────────────────────────

describe('parseRecordQuery, accepted parameters', () => {
  it('reads the range, the free filters, and the paging', () => {
    const query = parseRecordQuery(
      params(
        '?from=2026-08-03&to=2026-08-16&profile_id=emp-a&department=sales' +
          '&status=late&exception=late_arrival&review_status=unreviewed' +
          '&payroll_blocking=true&saved_filter=needs_attention&page=2&limit=25',
      ),
    );

    expect(query).toEqual({
      from: '2026-08-03',
      to: '2026-08-16',
      profileIds: ['emp-a'],
      departments: ['sales'],
      statuses: ['late'],
      exceptionCodes: ['late_arrival'],
      reviewStatus: 'unreviewed',
      payrollBlocking: true,
      savedFilter: 'needs_attention',
      page: 2,
      limit: 25,
    });
  });

  it('reads a repeated parameter and a comma-separated one the same way', () => {
    const repeated = parseRecordQuery(params('?status=late&status=absent'));
    const separated = parseRecordQuery(params('?status=late,absent'));

    expect(repeated).toEqual(separated);
    expect(repeated.statuses).toEqual(['late', 'absent']);
  });

  it('drops a repeated value rather than filtering on it twice', () => {
    expect(parseRecordQuery(params('?status=late,late')).statuses).toEqual(['late']);
  });

  it('accepts every saved filter the Exception Queue offers', () => {
    for (const id of SAVED_FILTER_IDS) {
      expect(parseRecordQuery(params(`?saved_filter=${id}`)).savedFilter).toBe(id);
    }
  });

  it('accepts payroll_blocking=false as a filter rather than as an absent one', () => {
    expect(parseRecordQuery(params('?payroll_blocking=false')).payrollBlocking).toBe(false);
    expect(parseRecordQuery(params('?payroll_blocking=FALSE')).payrollBlocking).toBe(false);
  });
});

// ─── An absent filter is absent, not empty ───────────────────────────────────

describe('parseRecordQuery, absent parameters', () => {
  it('produces an empty query for an empty query string', () => {
    expect(parseRecordQuery(params(''))).toEqual({});
  });

  it('treats a cleared control as an absent filter, not an empty list', () => {
    // `?status=` is what a cleared select sends. An empty list would be an empty
    // intersection and would match nothing at all.
    const query = parseRecordQuery(params('?status=&department=&profile_id=&saved_filter='));

    expect(query).toEqual({});
    expect(Object.hasOwn(query, 'statuses')).toBe(false);
  });

  it('never produces an empty list for a list filter', () => {
    const query = parseRecordQuery(params('?status=,,&exception=,'));

    expect(query.statuses).toBeUndefined();
    expect(query.exceptionCodes).toBeUndefined();
  });
});

// ─── A value the module does not accept ──────────────────────────────────────

describe('parseRecordQuery, rejected parameters', () => {
  it('rejects a misspelled saved filter rather than widening the result set', () => {
    const error = rejection(() => parseRecordQuery(params('?saved_filter=payrol_blocking')));

    expect(error.code).toBe('invalid_parameter');
    expect(error.field).toBe('saved_filter');
    expect(error.message).toContain('payrol_blocking');
    // The message names what would have been accepted.
    expect(error.message).toContain('payroll_blocking');
  });

  it('rejects an unknown metric key', () => {
    const error = rejection(() => parseRecordQuery(params('?metric=attendance_ratio')));

    expect(error.code).toBe('invalid_parameter');
    expect(error.field).toBe('metric');
    expect(error.message).toContain('attendance_rate');
  });

  it('rejects an unknown status, department, exception code, and predicate', () => {
    expect(rejection(() => parseRecordQuery(params('?status=sleeping'))).field).toBe('status');
    expect(rejection(() => parseRecordQuery(params('?department=legal'))).field).toBe('department');
    expect(rejection(() => parseRecordQuery(params('?exception=too_keen'))).field).toBe('exception');
    expect(rejection(() => parseRecordQuery(params('?predicate=any_day'))).field).toBe('predicate');
  });

  it('rejects a list where one of several values is unaccepted', () => {
    // The valid values must not carry the invalid one through: a partially
    // honoured filter is a widened one.
    const error = rejection(() => parseRecordQuery(params('?status=late,sleeping,absent')));

    expect(error.field).toBe('status');
    expect(error.message).toContain('sleeping');
  });

  it('rejects a non-boolean payroll_blocking', () => {
    expect(rejection(() => parseRecordQuery(params('?payroll_blocking=yes'))).field).toBe(
      'payroll_blocking',
    );
  });

  it('rejects a review status outside the two values', () => {
    expect(rejection(() => parseRecordQuery(params('?review_status=partially'))).field).toBe(
      'review_status',
    );
  });

  it('rejects a page or limit that is not a whole number of one or more', () => {
    for (const search of ['?page=abc', '?page=0', '?page=-1', '?page=1.5', '?limit=nine']) {
      const error = rejection(() => parseRecordQuery(params(search)));
      expect(error.code).toBe('invalid_parameter');
    }
  });

  it('rejects a repeated single-valued parameter rather than choosing one', () => {
    const error = rejection(() => parseRecordQuery(params('?page=2&page=5')));

    expect(error.field).toBe('page');
    expect(error.message).toContain('one value');
  });

  it('rejects a malformed date and a date that names no day', () => {
    expect(rejection(() => parseRecordQuery(params('?from=03-08-2026'))).code).toBe('invalid_range');
    expect(rejection(() => parseRecordQuery(params('?to=2026-02-30'))).code).toBe('invalid_range');
    expect(rejection(() => parseRecordQuery(params('?from=2026-8-3'))).field).toBe('from');
  });

  it('accepts a leap day in a leap year and rejects it otherwise', () => {
    expect(parseRecordQuery(params('?from=2028-02-29')).from).toBe('2028-02-29');
    expect(rejection(() => parseRecordQuery(params('?from=2026-02-29'))).code).toBe('invalid_range');
  });
});

// ─── The metric drill-down ───────────────────────────────────────────────────

describe('the metric drill-down', () => {
  it('conjoins the metric scope onto the active filters', () => {
    const query = parseRecordQuery(params('?from=2026-08-03&to=2026-08-16&metric=absence_count'));
    const expected = recordQueryForMetric('absence_count', {
      from: '2026-08-03',
      to: '2026-08-16',
    });

    expect(query).toEqual({ ...expected });
  });

  it('keeps the caller paging while narrowing the match', () => {
    const query = parseRecordQuery(params('?metric=overtime_hours&page=3&limit=40'));

    expect(query.page).toBe(3);
    expect(query.limit).toBe(40);
    expect(query.predicates).toBeDefined();
  });

  it('narrows rather than widens: a record outside the metric scope stops matching', () => {
    const record = absentRecord();

    expect(matchesRecordQuery(record, parseRecordQuery(params('')))).toBe(true);
    expect(
      matchesRecordQuery(record, parseRecordQuery(params('?metric=overtime_hours'))),
    ).toBe(false);
    expect(
      matchesRecordQuery(record, parseRecordQuery(params('?metric=absence_count'))),
    ).toBe(true);
  });

  it('leaves paging out of a metric query', () => {
    const query = parseMetricQuery(params('?metric=absence_count&page=3&limit=40'));

    expect(Object.hasOwn(query, 'page')).toBe(false);
    expect(Object.hasOwn(query, 'limit')).toBe(false);
  });
});

/** One absent day: enough of a record for the query predicates to read. */
function absentRecord(): DailyAttendanceRecord {
  return {
    profileId: 'emp-b',
    workDate: '2026-08-10',
    scheduledStart: '2026-08-10T13:00:00.000Z',
    scheduledEnd: '2026-08-10T21:00:00.000Z',
    scheduledHours: 8,
    firstClockIn: null,
    lastClockOut: null,
    hasOpenSession: false,
    workedHours: 0,
    paidBreakMinutes: 0,
    unpaidBreakMinutes: 0,
    lateMinutes: 0,
    earlyDepartureMinutes: 0,
    derivedStatus: 'absent',
    statusRuleId: 'AS-07',
    exceptions: [
      {
        code: 'absent',
        ruleId: 'AX-05',
        ruleDescription: 'Scheduled, no clock-in, and the shift has ended.',
        payrollBlocking: false,
      },
    ],
    payrollBlocking: false,
    reviewedAt: null,
    sessions: [],
  };
}

// ─── Required parameters ─────────────────────────────────────────────────────

describe('required parameters', () => {
  it('reads a required identifier and reports its absence by name', () => {
    expect(requiredIdentifier(params('?profile_id=emp-a'), 'profile_id')).toBe('emp-a');

    const error = rejection(() => requiredIdentifier(params(''), 'profile_id'));
    expect(error.field).toBe('profile_id');
    expect(error.message).toContain('profile_id');
  });

  it('reads a required range and reports the missing end by name', () => {
    expect(requiredDateRange(params('?from=2026-08-03&to=2026-08-16'))).toEqual({
      from: '2026-08-03',
      to: '2026-08-16',
    });

    expect(rejection(() => requiredDateRange(params('?from=2026-08-03'))).field).toBe('to');
  });

  it('reads an optional date as undefined when absent and validates it when present', () => {
    expect(optionalDate(params(''), 'date')).toBeUndefined();
    expect(optionalDate(params('?date=2026-08-10'), 'date')).toBe('2026-08-10');
    expect(rejection(() => requiredDate(params(''), 'date')).field).toBe('date');
  });
});

// ─── A single profile identifier ─────────────────────────────────────────────
//
// Used by the pay-settings read, which addresses one row by `profile_id` rather
// than intersecting a list filter with the caller's visibility. A value that
// reaches Postgres unparseable comes back as a driver error, which the failure
// contract can only report as a retryable 500 — the wrong answer for an input no
// amount of retrying will fix.
//
// Feature: time-attendance-ui-redesign, task 8.2. Requirements: 21.15

describe('optionalProfileId', () => {
  const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  it('is undefined when the parameter is absent or empty', () => {
    expect(optionalProfileId(params(''), 'profile_id')).toBeUndefined();
    expect(optionalProfileId(params('?profile_id='), 'profile_id')).toBeUndefined();
  });

  it('accepts an identifier of the shape profiles.id stores, in either case', () => {
    expect(optionalProfileId(params(`?profile_id=${ID}`), 'profile_id')).toBe(ID);
    expect(optionalProfileId(params(`?profile_id=${ID.toUpperCase()}`), 'profile_id')).toBe(
      ID.toUpperCase(),
    );
  });

  it('reports a value that is not an identifier as an invalid parameter', () => {
    const error = rejection(() => optionalProfileId(params('?profile_id=emp-a'), 'profile_id'));

    expect(error.code).toBe('invalid_parameter');
    expect(error.field).toBe('profile_id');
    expect(error.message).toContain('emp-a');
  });

  it('reports a near miss rather than accepting it', () => {
    // One digit short, and a uuid-shaped string with a non-hex character.
    expect(
      rejection(() => optionalProfileId(params(`?profile_id=${ID.slice(0, -1)}`), 'profile_id'))
        .field,
    ).toBe('profile_id');
    expect(
      rejection(() =>
        optionalProfileId(params('?profile_id=3f2504e0-4f89-41d3-9a0c-0305e82c330z'), 'profile_id'),
      ).field,
    ).toBe('profile_id');
  });

  it('refuses two different identifiers rather than picking one', () => {
    // Two names is two intentions. Answering about one of them silently answers a
    // question nobody asked. A repeat of the same name is one intention, so it is
    // accepted.
    const other = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

    expect(
      rejection(() =>
        optionalProfileId(params(`?profile_id=${ID}&profile_id=${other}`), 'profile_id'),
      ).field,
    ).toBe('profile_id');
    expect(optionalProfileId(params(`?profile_id=${ID}&profile_id=${ID}`), 'profile_id')).toBe(ID);
  });
});
