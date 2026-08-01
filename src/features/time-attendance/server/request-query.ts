// src/features/time-attendance/server/request-query.ts
// Query strings turned into the queries the services accept, without trusting
// anything in them.
//
// A `RecordQuery` is a conjunction of filters, so the only way a bad parameter
// can hurt is by widening the result set. There are two ways that happens, and
// both are refused here:
//
//   1. **A dropped filter.** Ignoring `?saved_filter=payrol_blocking` — note the
//      typo — answers with every record in the range instead of the blocking
//      ones. The caller sees a full queue and reasonably concludes the filter
//      found everything. Every unrecognised value is therefore reported as a 400
//      naming the field and the accepted set, never dropped.
//   2. **A silently defaulted value.** `?page=abc` read as page 1 answers a
//      different question than the one asked, and `?limit=0` read as the cap
//      does too. Both are reported.
//
// The domain layer already refuses to widen: `matchesRecordQuery` treats a
// predicate id outside its table as unsatisfiable rather than as a no-op. That
// is the backstop. It produces an empty result, which is safe but silent, so the
// route says which value it could not accept instead.
//
// ## Where the accepted values come from
//
// The status, exception, department, saved-filter, predicate, and metric
// vocabularies are read off the tables that define them — `STATUS_RULES`,
// `EXCEPTION_RULES`, `roleToDepartment`, `SAVED_FILTER_IDS`, `recordPredicate`,
// `isMetricKey`. None of them is retyped here. A thirteenth status added to the
// matrix is accepted by this parser the moment it is added to the matrix, and a
// hand-written copy of the list is one more thing that could disagree with the
// rules (Requirements 19.1, 19.2).
//
// ## Parameter names
//
// Snake case, matching the query strings the existing routes already read.
// Every list parameter accepts repetition and comma separation, so
// `?status=late&status=absent` and `?status=late,absent` are the same request.
// An empty value is absent rather than an empty list: `?status=` is what a
// cleared select control sends, and an empty list in a `RecordQuery` is an empty
// intersection that matches nothing.
//
// | parameter          | shape                        | notes                                     |
// | ------------------ | ---------------------------- | ----------------------------------------- |
// | `view`             | one of the six export views  | on an export request                      |
// | `date`             | `YYYY-MM-DD`                 | single-date reads                         |
// | `from`, `to`       | `YYYY-MM-DD`                 | inclusive at both ends                    |
// | `profile_id`       | list                         | narrowed again by the caller's visibility |
// | `department`       | list of departments          | one value only, on a coverage read        |
// | `mode`             | `live` \| `projected`        | required on a coverage read               |
// | `request_id`       | record identifier            | the impact preview's subject              |
// | `status`           | list of derived statuses     |                                           |
// | `exception`        | list of exception codes      |                                           |
// | `review_status`    | `reviewed` \| `unreviewed`   |                                           |
// | `payroll_blocking` | `true` \| `false`            |                                           |
// | `saved_filter`     | one of the thirteen filters  |                                           |
// | `predicate`        | list of named predicates     | carried by a metric drill-down            |
// | `metric`           | one of the fourteen metrics  | conjoins that metric's own scope          |
// | `page`, `limit`    | positive integers            | `limit` is capped by the service at 100    |
// | `pto_type`         | list of request types        | on the Request_Inbox read                 |
// | `coverage_risk`    | list of coverage statuses    | on the Request_Inbox read                 |
//
// Requirements: 12.3 (the saved filters and the free filters), 13.2 (the Overview
// filters), 13.5 (a metric drill-down selects the rows the metric was computed
// over), 20.8 (the row cap belongs to the service, not to the caller), 21.15 (a
// parameter naming data outside the permitted set cannot widen a read).

import { APP_ROLES, roleToDepartment, type Department } from '@/lib/permissions';

import {
  DERIVED_STATUSES,
  EXCEPTION_CODES,
  METRIC_KEYS,
  RECORD_PREDICATES,
  SAVED_FILTER_IDS,
  isMetricKey,
  isSavedFilterId,
  mergeRecordQuery,
  recordQueryForMetric,
  type RecordPredicateId,
  type RecordQuery,
  type ReviewStatusFilter,
} from '../domain/attendance';
import { AUDIT_ACTION_IDS, type AuditQuery } from '../domain/audit';
import { COVERAGE_SEVERITY, type CoverageStatus } from '../domain/coverage';
import { EXPORT_VIEWS, isExportView, type ExportView } from '../domain/csv';
import { PTO_TYPE_TO_BALANCE_FIELD, type RequestQuery } from '../domain/pto';
import type { DateRange } from '../domain/types';
import { addCalendarDays } from '../domain/work-date';
import { PTO_STATUS_STYLES, type PTOStatus, type PTOType } from '../types';
import { ApiRequestError } from './api-response';
import type { MetricQuery } from './attendance-service';
import type { CoverageMode, CoverageQuery } from './coverage-service';
import type { ExportQuery } from './export-service';

// ─── The accepted vocabularies, read off the tables that define them ─────────

/**
 * The twelve derived statuses and the exception codes, from the rule tables that
 * define them.
 *
 * Re-exported rather than rebuilt: the domain layer reads both off
 * `STATUS_RULES` and `EXCEPTION_RULES`, and the screens' filter controls read the
 * same two lists, so the set this parser accepts is the set the rules can produce
 * and the set a control can offer.
 */
export { DERIVED_STATUSES, EXCEPTION_CODES };

/** The departments, through the same role-to-department mapping the reads use. */
export const DEPARTMENTS: readonly Department[] = distinct(APP_ROLES.map(roleToDepartment));

/** Every named predicate: the thirteen saved filters plus the metric scopes. */
const PREDICATE_IDS: readonly RecordPredicateId[] = RECORD_PREDICATES.map(
  (predicate) => predicate.id,
);

const REVIEW_STATUSES: readonly ReviewStatusFilter[] = ['reviewed', 'unreviewed'];

/** The two coverage figures a caller can ask for. */
export const COVERAGE_MODES: readonly CoverageMode[] = ['live', 'projected'];

/**
 * The request types the `pto_requests.pto_type` constraint accepts.
 *
 * Read off `PTO_TYPE_TO_BALANCE_FIELD`, which is the map every balance movement
 * goes through, so the set this parser accepts is the set the service can cost
 * and the database can store. `/api/pto` hands the same list back to the caller,
 * which is how the composer's type selector offers only accepted types without
 * keeping a list of its own (Requirement 10, criterion 20).
 */
export const PTO_TYPES = Object.keys(PTO_TYPE_TO_BALANCE_FIELD) as readonly PTOType[];

/**
 * The statuses a `pto_requests` row can hold.
 *
 * Read off `PTO_STATUS_STYLES`, the table that has to name every status in order
 * to render one. The inbox control offers the four of `REQUEST_STATUS_FILTERS`;
 * the query accepts all seven, because an employee's own list shows five states
 * and a decided-request filter is a legitimate question (Requirements 7.7, 11.6).
 */
export const PTO_STATUSES = Object.keys(PTO_STATUS_STYLES) as readonly PTOStatus[];

/** The four coverage outcomes, from the severity ordering the module compares by. */
export const COVERAGE_RISKS = Object.keys(COVERAGE_SEVERITY) as readonly CoverageStatus[];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE_NUMBER_PATTERN = /^\d+$/;

function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

// ─── Reading raw values ──────────────────────────────────────────────────────

/**
 * The distinct non-empty values given for a field, across repetition and comma
 * separation.
 */
function rawValues(params: URLSearchParams, field: string): string[] {
  const values: string[] = [];
  for (const given of params.getAll(field)) {
    for (const token of given.split(',')) {
      const value = token.trim();
      if (value !== '' && !values.includes(value)) values.push(value);
    }
  }
  return values;
}

/**
 * The single value given for a field, or undefined.
 *
 * A repeated single-valued parameter is reported rather than resolved by taking
 * the first: `?page=2&page=5` states two intentions, and picking one of them
 * silently answers a question nobody asked.
 */
function singleValue(params: URLSearchParams, field: string): string | undefined {
  const values = rawValues(params, field);
  if (values.length === 0) return undefined;
  if (values.length > 1) {
    throw new ApiRequestError(
      'invalid_parameter',
      `${field} accepts one value, received ${values.length}`,
      field,
    );
  }
  return values[0];
}

function unacceptedValue(
  field: string,
  value: string,
  accepted: readonly string[],
): ApiRequestError {
  return new ApiRequestError(
    'invalid_parameter',
    `${field}: "${value}" is not accepted. Accepted values are ${accepted.join(', ')}.`,
    field,
  );
}

/** A list filter, every value checked against the accepted set. */
function acceptedList<T extends string>(
  params: URLSearchParams,
  field: string,
  accepted: readonly T[],
): readonly T[] | undefined {
  const values = rawValues(params, field);
  if (values.length === 0) return undefined;

  for (const value of values) {
    if (!accepted.includes(value as T)) throw unacceptedValue(field, value, accepted);
  }
  return values as T[];
}

/** A free list filter: shape checked, membership left to authorisation. */
function identifierList(params: URLSearchParams, field: string): readonly string[] | undefined {
  const values = rawValues(params, field);
  return values.length === 0 ? undefined : values;
}

// ─── Scalars ─────────────────────────────────────────────────────────────────

/**
 * A `YYYY-MM-DD` value that names a real date.
 *
 * Two checks, because the shape and the date are different mistakes: `2026-2-3`
 * fails the pattern, and `2026-02-30` matches it while naming no date.
 * `addCalendarDays(value, 0)` rejects the second, and the same `invalid_range`
 * code the service uses is reported here, so the same mistake reads the same
 * whichever layer catches it.
 *
 * Exported so `request-body.ts` judges a date in a JSON body by this same
 * function: a malformed date should read identically whether it arrived in a
 * query string or in a request body.
 */
export function assertCalendarDate(value: string, field: string): string {
  if (DATE_PATTERN.test(value)) {
    try {
      return addCalendarDays(value, 0);
    } catch {
      // Matches the shape, names no date. Reported below.
    }
  }

  throw new ApiRequestError(
    'invalid_range',
    `${field} must be a calendar date as YYYY-MM-DD, received "${value}"`,
    field,
  );
}

/** A calendar date, or undefined when the parameter is absent. */
export function optionalDate(params: URLSearchParams, field: string): string | undefined {
  const value = singleValue(params, field);
  return value === undefined ? undefined : assertCalendarDate(value, field);
}

/** A calendar date the read cannot proceed without. */
export function requiredDate(params: URLSearchParams, field: string): string {
  const value = singleValue(params, field);
  if (value === undefined) {
    throw new ApiRequestError('invalid_range', `${field} is required as YYYY-MM-DD`, field);
  }
  return assertCalendarDate(value, field);
}

/**
 * An inclusive `from`–`to` range both of whose ends were given.
 *
 * Order is checked by the service, which owns the range rules including the
 * width cap, so there is one place a range is judged rather than two that can
 * disagree.
 */
export function requiredDateRange(params: URLSearchParams): DateRange {
  return { from: requiredDate(params, 'from'), to: requiredDate(params, 'to') };
}

/** A required non-empty identifier, such as the subject of a trend read. */
export function requiredIdentifier(params: URLSearchParams, field: string): string {
  const value = singleValue(params, field);
  if (value === undefined) {
    throw new ApiRequestError('invalid_parameter', `${field} is required`, field);
  }
  return value;
}

/**
 * The shape `profiles.id` and every other identifier column stores, as Postgres
 * renders a uuid.
 *
 * Exported so a JSON body is judged by the same shape a query string is.
 */
export const RECORD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One profile identifier, or undefined when the parameter is absent.
 *
 * Stricter than `identifierList`, and deliberately so. A list `profile_id`
 * filter is intersected with the caller's visibility, so a value that names no
 * employee can only shrink a result set and membership is settled by
 * authorisation rather than by shape. A read that addresses a single row by
 * `profile_id` has no such intersection: an unparseable value reaches Postgres,
 * comes back as an invalid-uuid-syntax error, and the failure contract would
 * have to report it as `read_failed` — a 500 the caller is invited to retry,
 * when retrying the same malformed value can never succeed. Checking the shape
 * here answers it as the 400 it is.
 *
 * Requirements: 21.15
 */
export function optionalProfileId(params: URLSearchParams, field: string): string | undefined {
  const value = singleValue(params, field);
  if (value === undefined) return undefined;

  if (!RECORD_ID_PATTERN.test(value)) {
    throw new ApiRequestError(
      'invalid_parameter',
      `${field} must be a profile identifier, received "${value}"`,
      field,
    );
  }
  return value;
}

/**
 * A required identifier that addresses one stored row by primary key.
 *
 * Shape-checked for the same reason as `optionalProfileId`: a read that addresses
 * a row by `id` has no filter to intersect, so an unparseable value reaches
 * Postgres, returns an invalid-uuid-syntax error, and the failure contract can
 * only report it as a retryable 500 — the wrong answer for an input no amount of
 * retrying will fix. Used by the impact preview for `request_id`.
 *
 * Requirements: 21.15
 */
export function requiredRecordId(params: URLSearchParams, field: string): string {
  const value = requiredIdentifier(params, field);

  if (!RECORD_ID_PATTERN.test(value)) {
    throw new ApiRequestError(
      'invalid_parameter',
      `${field} must be a record identifier, received "${value}"`,
      field,
    );
  }
  return value;
}

function optionalPositiveInteger(params: URLSearchParams, field: string): number | undefined {
  const value = singleValue(params, field);
  if (value === undefined) return undefined;

  if (!WHOLE_NUMBER_PATTERN.test(value)) {
    throw new ApiRequestError(
      'invalid_parameter',
      `${field} must be a whole number of 1 or more, received "${value}"`,
      field,
    );
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ApiRequestError(
      'invalid_parameter',
      `${field} must be a whole number of 1 or more, received "${value}"`,
      field,
    );
  }
  return parsed;
}

function optionalBoolean(params: URLSearchParams, field: string): boolean | undefined {
  const value = singleValue(params, field);
  if (value === undefined) return undefined;

  const lowered = value.toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  throw unacceptedValue(field, value, ['true', 'false']);
}

function optionalFrom<T extends string>(
  params: URLSearchParams,
  field: string,
  accepted: readonly T[],
): T | undefined {
  const value = singleValue(params, field);
  if (value === undefined) return undefined;
  if (!accepted.includes(value as T)) throw unacceptedValue(field, value, accepted);
  return value as T;
}

/** A value from a closed set that the read cannot proceed without. */
function requiredFrom<T extends string>(
  params: URLSearchParams,
  field: string,
  accepted: readonly T[],
): T {
  const value = optionalFrom(params, field, accepted);
  if (value === undefined) {
    throw new ApiRequestError(
      'invalid_parameter',
      `${field} is required, as one of ${accepted.join(', ')}`,
      field,
    );
  }
  return value;
}

// ─── The queries ─────────────────────────────────────────────────────────────

/**
 * The record filters, without paging.
 *
 * Every field is assigned only when its parameter was given, so an absent filter
 * is an absent key rather than `undefined` on the object. `matchesRecordQuery`
 * treats a present key as an active conjunct, and an explicit `undefined` would
 * read the same as absent today but would stop doing so the moment a filter
 * learns a third state.
 *
 * Requirements: 12.3, 13.2
 */
export function parseMetricQuery(params: URLSearchParams): MetricQuery {
  const query: MetricQuery = {};

  const from = optionalDate(params, 'from');
  if (from !== undefined) query.from = from;

  const to = optionalDate(params, 'to');
  if (to !== undefined) query.to = to;

  const profileIds = identifierList(params, 'profile_id');
  if (profileIds !== undefined) query.profileIds = profileIds;

  const departments = acceptedList(params, 'department', DEPARTMENTS);
  if (departments !== undefined) query.departments = departments;

  const statuses = acceptedList(params, 'status', DERIVED_STATUSES);
  if (statuses !== undefined) query.statuses = statuses;

  const exceptionCodes = acceptedList(params, 'exception', EXCEPTION_CODES);
  if (exceptionCodes !== undefined) query.exceptionCodes = exceptionCodes;

  const reviewStatus = optionalFrom(params, 'review_status', REVIEW_STATUSES);
  if (reviewStatus !== undefined) query.reviewStatus = reviewStatus;

  const payrollBlocking = optionalBoolean(params, 'payroll_blocking');
  if (payrollBlocking !== undefined) query.payrollBlocking = payrollBlocking;

  const savedFilter = singleValue(params, 'saved_filter');
  if (savedFilter !== undefined) {
    if (!isSavedFilterId(savedFilter)) {
      throw unacceptedValue('saved_filter', savedFilter, SAVED_FILTER_IDS);
    }
    query.savedFilter = savedFilter;
  }

  const predicates = acceptedList(params, 'predicate', PREDICATE_IDS);
  if (predicates !== undefined) query.predicates = predicates;

  const metric = singleValue(params, 'metric');
  if (metric === undefined) return query;

  // A metric drill-down conjoins the metric's own scope onto the active filters,
  // through the same function `aggregateMetrics` computed the figure with, so the
  // rows a caller drills into are the rows the figure was taken from.
  if (!isMetricKey(metric)) throw unacceptedValue('metric', metric, METRIC_KEYS);
  return recordQueryForMetric(metric, query);
}

/**
 * The record filters with paging.
 *
 * `limit` is passed through as asked and capped by the service at 100 rows
 * (Requirement 20, criterion 8), so the cap lives in one place and a caller
 * cannot raise it.
 *
 * Requirements: 12.3, 12.17, 13.2, 20.8
 */
export function parseRecordQuery(params: URLSearchParams): RecordQuery {
  const paging: RecordQuery = {};

  const page = optionalPositiveInteger(params, 'page');
  if (page !== undefined) paging.page = page;

  const limit = optionalPositiveInteger(params, 'limit');
  if (limit !== undefined) paging.limit = limit;

  // The paging query is the base, so it survives a metric drill-down: the
  // metric scope narrows what is matched and the caller keeps the page they
  // asked for.
  return mergeRecordQuery(paging, parseMetricQuery(params));
}

/**
 * One audit-trail question, from a query string.
 *
 * | parameter       | shape                       | notes                                     |
 * | --------------- | --------------------------- | ----------------------------------------- |
 * | `from`, `to`    | `YYYY-MM-DD`                | the affected work date, either end alone   |
 * | `profile_id`    | list                        | the affected employees                    |
 * | `action`        | list of recorded actions    | from `AUDIT_ACTIONS`                      |
 * | `actor_id`      | list                        | who performed the action                  |
 * | `page`, `limit` | positive integers           | `limit` is capped by the service at 100    |
 *
 * The four filters of Requirement 16, criterion 4, and nothing else. An
 * unrecognised action is reported rather than dropped, for the reason
 * `parseMetricQuery` reports one: a dropped filter answers with every entry in the
 * trail while the caller reads it as the filtered set — and on an audit trail that
 * is the difference between "no coverage override was recorded" and "you asked the
 * wrong question".
 *
 * `from` and `to` are independent, as they are on the inbox read: "everything
 * since the period opened" is a reasonable audit question with no upper bound, and
 * an absent bound simply leaves that end unfiltered rather than defaulting to a
 * window nobody asked for. The page is what bounds the read.
 *
 * `actor_id` is a shape-free identifier list for the same reason `profile_id` is:
 * it narrows a set rather than addressing a row, so a value naming nobody can only
 * shrink the result and membership is settled by the caller's visibility.
 *
 * Requirements: 16.4, 16.7, 21.15
 */
export function parseAuditQuery(params: URLSearchParams): AuditQuery {
  const query: AuditQuery = {};

  const from = optionalDate(params, 'from');
  if (from !== undefined) query.from = from;

  const to = optionalDate(params, 'to');
  if (to !== undefined) query.to = to;

  const profileIds = identifierList(params, 'profile_id');
  if (profileIds !== undefined) query.profileIds = profileIds;

  const actions = acceptedList(params, 'action', AUDIT_ACTION_IDS);
  if (actions !== undefined) query.actions = actions;

  const actorProfileIds = identifierList(params, 'actor_id');
  if (actorProfileIds !== undefined) query.actorProfileIds = actorProfileIds;

  const page = optionalPositiveInteger(params, 'page');
  if (page !== undefined) query.page = page;

  const limit = optionalPositiveInteger(params, 'limit');
  if (limit !== undefined) query.limit = limit;

  return query;
}

/**
 * One coverage question, from a query string.
 *
 * | parameter    | shape                     | notes                                  |
 * | ------------ | ------------------------- | -------------------------------------- |
 * | `mode`       | `live` \| `projected`     | required                               |
 * | `from`, `to` | `YYYY-MM-DD`              | together, or neither                    |
 * | `department` | one department            | optional filter                        |
 *
 * `mode` is required rather than defaulted. Live and projected are two different
 * figures answering two different questions — current operational coverage, and
 * expected coverage from schedules and absences — and Requirement 6, criterion 15
 * asks the panel to keep them visibly apart. A default would pick one of them on
 * the caller's behalf and label it as the other's answer.
 *
 * `from` and `to` are read together or not at all. An absent range resolves to
 * `fallbackDate`, which the route resolves as today in the business timezone: a
 * browser sending its own local date would ask about the wrong work date for the
 * hour either side of midnight. One end given without the other is a mistake
 * rather than a default, and is reported by naming the missing end, exactly as
 * `requiredDateRange` does.
 *
 * Two rules deliberately stay in the service rather than being repeated here: a
 * `live` read answers a single date, and a range has a width cap. Both are range
 * rules, `coverage-service.ts` owns them, and a second copy is a second thing to
 * keep in step.
 *
 * `proposedAbsence` is not readable from a query string at all. It is the absence
 * an Approval_Impact_Preview is costing, and `getImpact` builds it from the stored
 * request's own dates. Accepting one here would let a caller have the server
 * project a hypothetical absence for any employee, which is a question no screen
 * asks and no permission covers.
 *
 * Requirements: 6.15, 8.12, 9.1, 21.15
 */
export function parseCoverageQuery(
  params: URLSearchParams,
  fallbackDate: string,
): CoverageQuery {
  const mode = requiredFrom(params, 'mode', COVERAGE_MODES);
  const from = optionalDate(params, 'from');
  const to = optionalDate(params, 'to');

  if ((from === undefined) !== (to === undefined)) {
    const missing = from === undefined ? 'from' : 'to';
    throw new ApiRequestError(
      'invalid_range',
      `from and to are given together; ${missing} is missing`,
      missing,
    );
  }

  const query: CoverageQuery = {
    mode,
    from: from ?? fallbackDate,
    to: to ?? fallbackDate,
  };

  const department = optionalFrom(params, 'department', DEPARTMENTS);
  if (department !== undefined) query.department = department;

  return query;
}

/**
 * One export request, from a query string.
 *
 * | parameter    | shape                        | notes                                    |
 * | ------------ | ---------------------------- | ---------------------------------------- |
 * | `view`       | one of the six export views  | required                                 |
 * | `from`, `to` | `YYYY-MM-DD`                 | required by four of the six views         |
 * | `profile_id` | one identifier, or a list    | one for `employee_trends`, a list elsewhere |
 * | `department` | one department               | on `coverage_history`                    |
 * | (the rest)   | the requesting view's filters | read per view                           |
 *
 * `view` is required and is refused when unrecognised rather than defaulted:
 * answering a request for an unknown view with the attendance records export
 * hands somebody a file that does not contain what they asked for.
 *
 * The filters are parsed by view, because the same parameter means different
 * things to different views. `profile_id` is a list filter on the two record views
 * and on the inbox, where it narrows a set, and a single employee on
 * `employee_trends`, where it names the subject — so it is read through
 * `parseMetricQuery` in the first case and `requiredRecordId` in the second.
 * Parsing every view's filters regardless would accept `saved_filter` on a
 * coverage export and quietly ignore it.
 *
 * The range is read here for every view and required by none of them: which views
 * cannot be read without one is the Export_Service's rule, and it reports the
 * missing end by name. `payroll_ready` takes no filters at all — the calculation
 * runs over the active roster for a period — so its query is the range alone.
 *
 * Requirements: 15.1, 15.2, 15.6, 21.15
 */
export function parseExportQuery(params: URLSearchParams): {
  view: ExportView;
  query: ExportQuery;
} {
  const requested = requiredIdentifier(params, 'view');
  if (!isExportView(requested)) {
    throw unacceptedValue('view', requested, EXPORT_VIEWS);
  }

  const query: ExportQuery = {};

  const from = optionalDate(params, 'from');
  const to = optionalDate(params, 'to');
  if (from !== undefined || to !== undefined) {
    query.range = {
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    };
  }

  switch (requested) {
    case 'attendance_records':
    case 'exception_queue':
      query.records = parseRecordQuery(params);
      break;

    case 'time_off_activity':
      query.requests = parseRequestQuery(params);
      break;

    case 'coverage_history': {
      const department = optionalFrom(params, 'department', DEPARTMENTS);
      if (department !== undefined) query.department = department;
      break;
    }

    case 'employee_trends':
      query.profileId = requiredRecordId(params, 'profile_id');
      break;

    case 'payroll_ready':
      break;
  }

  return { view: requested, query };
}

/**
 * One Request_Inbox question, from a query string.
 *
 * | parameter       | shape                        | notes                                      |
 * | --------------- | ---------------------------- | ------------------------------------------ |
 * | `status`        | list of request statuses     | the control offers four of the seven       |
 * | `department`    | list of departments          |                                            |
 * | `profile_id`    | list                         | narrowed again by the caller's visibility  |
 * | `pto_type`      | list of accepted types       |                                            |
 * | `from`, `to`    | `YYYY-MM-DD`                 | overlap, and either end may stand alone    |
 * | `coverage_risk` | list of coverage statuses    |                                            |
 * | `page`, `limit` | positive integers            | `limit` is capped by the domain at 50      |
 *
 * The six filters of Requirement 7, criteria 6 and 7, and nothing else. Every
 * unrecognised value is reported rather than dropped, for the same reason
 * `parseMetricQuery` reports one: a dropped status filter answers with every
 * request in the window while the caller reads it as the filtered set.
 *
 * `from` and `to` are independent here, unlike on a coverage read. Either end
 * alone is a meaningful inbox question — "requests from today onwards" is the
 * default view of a leave calendar — and the service resolves the missing end to
 * its own bounded window rather than to the whole table.
 *
 * `limit` is passed through as asked and capped by `requestPageLimit` at fifty
 * rows (Requirement 7, criterion 12), so the cap lives in the domain layer and a
 * caller cannot raise it.
 *
 * Requirements: 7.6, 7.7, 7.12, 11.6, 21.15
 */
export function parseRequestQuery(params: URLSearchParams): RequestQuery {
  const query: RequestQuery = {};

  const statuses = acceptedList(params, 'status', PTO_STATUSES);
  if (statuses !== undefined) query.statuses = statuses;

  const departments = acceptedList(params, 'department', DEPARTMENTS);
  if (departments !== undefined) query.departments = departments;

  const profileIds = identifierList(params, 'profile_id');
  if (profileIds !== undefined) query.profileIds = profileIds;

  const ptoTypes = acceptedList(params, 'pto_type', PTO_TYPES);
  if (ptoTypes !== undefined) query.ptoTypes = ptoTypes;

  const from = optionalDate(params, 'from');
  if (from !== undefined) query.from = from;

  const to = optionalDate(params, 'to');
  if (to !== undefined) query.to = to;

  const coverageRisks = acceptedList(params, 'coverage_risk', COVERAGE_RISKS);
  if (coverageRisks !== undefined) query.coverageRisks = coverageRisks;

  const page = optionalPositiveInteger(params, 'page');
  if (page !== undefined) query.page = page;

  const limit = optionalPositiveInteger(params, 'limit');
  if (limit !== undefined) query.limit = limit;

  return query;
}
