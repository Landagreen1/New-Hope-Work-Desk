// src/features/time-attendance/shared/record-query.ts
// A `RecordQuery` as the query string `/api/attendance/records` reads back.
//
// `server/request-query.ts` turns a query string into a `RecordQuery`. This is
// the other direction, and it exists because a screen that filters must ask the
// server the narrowed question rather than narrow the rows it already holds.
// Requirement 5, criterion 4 ties every Team Today counter to the
// Attendance_Service, and criterion 5 ties the rows to the counter that produced
// them: both hold only if selecting a counter re-reads under that counter's
// query. A client-side `Array.filter` over held rows would satisfy neither, and
// it would quietly disagree with the counter the moment the two were read a
// minute apart.
//
// Parameter names are the ones `parseRecordQuery` reads, and nothing else is
// emitted, so a round trip through a route reproduces the query it was given.
// List filters are appended once per value rather than comma-joined — both forms
// parse identically, and repetition needs no escaping decision for a value that
// could contain a comma.
//
// ## The one shape a query string cannot carry
//
// An empty list filter — `statuses: []` — is an empty intersection and matches
// nothing. A query string has no way to say that: dropping the parameter widens
// the read to every record in the range, which is the one failure mode
// `parseRecordQuery` was written to refuse. So an empty list is dropped *and*
// reported through `unsatisfiable`, and a caller is expected to skip the read
// rather than issue a wider one. The module's own screens never build one — a
// cleared select produces an absent key, not an empty array — so this is a guard
// against a future caller, not a state a reader can reach.
//
// Requirements: 5.4, 5.5, 5.9, 12.3, 13.5, 20.8

import type { RecordQuery } from '../domain/attendance';

/** A query as parameters, with whether it can be expressed at all. */
export interface SerialisedRecordQuery {
  params: URLSearchParams;
  /**
   * True when a list filter was present and empty. The query matches nothing,
   * and the parameters below would read as the unfiltered range, so the caller
   * must not issue the request.
   */
  unsatisfiable: boolean;
}

/**
 * The parameters for a query, in a fixed order.
 *
 * Fixed so the resulting string is stable: it is used as a request key by
 * `useAsyncResource`, and a key that varied with object insertion order would
 * refetch on renders that changed nothing.
 */
export function recordQuerySearchParams(query: RecordQuery): SerialisedRecordQuery {
  const params = new URLSearchParams();
  let unsatisfiable = false;

  function scalar(field: string, value: string | number | boolean | undefined): void {
    if (value === undefined) return;
    params.set(field, String(value));
  }

  function list(field: string, values: readonly string[] | undefined): void {
    if (values === undefined) return;
    if (values.length === 0) {
      unsatisfiable = true;
      return;
    }
    for (const value of values) params.append(field, value);
  }

  scalar('from', query.from);
  scalar('to', query.to);
  list('profile_id', query.profileIds);
  list('department', query.departments);
  list('status', query.statuses);
  list('exception', query.exceptionCodes);
  scalar('review_status', query.reviewStatus);
  scalar('payroll_blocking', query.payrollBlocking);
  scalar('saved_filter', query.savedFilter);
  list('predicate', query.predicates);
  scalar('page', query.page);
  scalar('limit', query.limit);

  return { params, unsatisfiable };
}

/** An endpoint path with a query's parameters appended. */
export function recordQueryUrl(
  path: string,
  query: RecordQuery,
): { url: string; unsatisfiable: boolean } {
  const { params, unsatisfiable } = recordQuerySearchParams(query);
  const search = params.toString();
  return { url: search === '' ? path : `${path}?${search}`, unsatisfiable };
}
