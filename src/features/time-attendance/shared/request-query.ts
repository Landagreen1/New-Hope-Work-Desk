// src/features/time-attendance/shared/request-query.ts
// A `RequestQuery` as the query string `/api/pto` reads back.
//
// `server/request-query.ts` turns a query string into a `RequestQuery`. This is
// the other direction, and it is the Request_Inbox's half of the same contract:
// the two files are named alike because they are the two ends of one round trip,
// and they live in different directories because only one of them may reach the
// database.
//
// It exists for the reason `shared/record-query.ts` exists. The inbox's rows are
// filtered, ordered, and capped at fifty by `buildRequestInbox` on the server
// (Requirement 7, criteria 6 through 8 and 12), so a filter control has to ask
// the server the narrowed question rather than narrow the rows the screen happens
// to be holding. A client-side `Array.filter` over a held page would filter a
// page of fifty and present the result as the whole match, and the coverage-risk
// indicator it filtered on is a figure only the Coverage_Service can produce.
//
// Parameter names are the ones `parseRequestQuery` reads, and nothing else is
// emitted, so a round trip through the route reproduces the query it was given.
// List filters are appended once per value rather than comma-joined — both forms
// parse identically, and repetition needs no escaping decision for a value that
// could contain a comma.
//
// ## The one shape a query string cannot carry
//
// An empty list filter — `statuses: []` — is an empty intersection and matches
// nothing. A query string has no way to say that: dropping the parameter widens
// the read to every request in the window, which is the one failure mode
// `parseRequestQuery` was written to refuse. So an empty list is dropped *and*
// reported through `unsatisfiable`, and a caller is expected to skip the read
// rather than issue a wider one. The inbox's own controls never build one — a
// cleared select produces an absent key, not an empty array — so this is a guard
// against a future caller, not a state a reader can reach.
//
// Requirements: 7.6, 7.7, 7.12

import type { RequestQuery } from '../domain/pto';

/** A query as parameters, with whether it can be expressed at all. */
export interface SerialisedRequestQuery {
  params: URLSearchParams;
  /**
   * True when a list filter was present and empty. The query matches nothing,
   * and the parameters below would read as the unfiltered window, so the caller
   * must not issue the request.
   */
  unsatisfiable: boolean;
}

/**
 * The parameters for one inbox query, in a fixed order.
 *
 * Fixed so the resulting string is stable: it is used as a request key by
 * `useAsyncResource`, and a key that varied with object insertion order would
 * refetch on renders that changed nothing.
 *
 * Requirements: 7.6, 7.7, 7.12
 */
export function requestQuerySearchParams(query: RequestQuery): SerialisedRequestQuery {
  const params = new URLSearchParams();
  let unsatisfiable = false;

  function scalar(field: string, value: string | number | undefined): void {
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

  list('status', query.statuses);
  list('department', query.departments);
  list('profile_id', query.profileIds);
  list('pto_type', query.ptoTypes);
  scalar('from', query.from);
  scalar('to', query.to);
  list('coverage_risk', query.coverageRisks);
  scalar('page', query.page);
  scalar('limit', query.limit);

  return { params, unsatisfiable };
}

/** An endpoint path with an inbox query's parameters appended. */
export function requestQueryUrl(
  path: string,
  query: RequestQuery,
): { url: string; unsatisfiable: boolean } {
  const { params, unsatisfiable } = requestQuerySearchParams(query);
  const search = params.toString();
  return { url: search === '' ? path : `${path}?${search}`, unsatisfiable };
}
