// src/features/time-attendance/shared/audit-query.ts
// An `AuditQuery` as the query string `/api/attendance/audit` reads back.
//
// The third instance of the module's one round trip, after `record-query.ts` and
// `request-query.ts`, and it exists for the same reason both of those do: the
// audit trail is filtered, ordered, and paged on the server, so a filter control
// has to ask the server the narrowed question rather than narrow the page it
// happens to be holding. Filtering a held page of a hundred and presenting the
// result as the whole match is the failure this avoids — and it would be a
// particularly bad one here, where the reader is trying to establish that
// something was or was not recorded.
//
// Parameter names are the ones `parseAuditQuery` reads, and nothing else is
// emitted, so a round trip through the route reproduces the query it was given.
// List filters are appended once per value rather than comma-joined: both forms
// parse identically, and repetition needs no escaping decision.
//
// An empty list filter is an empty intersection and matches nothing, which a
// query string cannot express — dropping the parameter would widen the read to
// every entry instead. So it is dropped *and* reported through `unsatisfiable`,
// and the caller skips the read rather than issuing a wider one. The view's own
// controls never build one, since a cleared select produces an absent key.
//
// Requirements: 16.4, 16.7

import type { AuditQuery } from '../domain/audit';

/** A query as parameters, with whether it can be expressed at all. */
export interface SerialisedAuditQuery {
  params: URLSearchParams;
  /**
   * True when a list filter was present and empty. The query matches nothing,
   * and the parameters below would read as the unfiltered trail, so the caller
   * must not issue the request.
   */
  unsatisfiable: boolean;
}

/**
 * The parameters for one audit query, in a fixed order.
 *
 * Fixed so the resulting string is stable: it is the request key
 * `useAsyncResource` compares by, and a key that varied with object insertion
 * order would refetch on renders that changed nothing.
 *
 * Requirements: 16.4, 16.7
 */
export function auditQuerySearchParams(query: AuditQuery): SerialisedAuditQuery {
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

  scalar('from', query.from);
  scalar('to', query.to);
  list('profile_id', query.profileIds);
  list('action', query.actions);
  list('actor_id', query.actorProfileIds);
  scalar('page', query.page);
  scalar('limit', query.limit);

  return { params, unsatisfiable };
}

/** An endpoint path with an audit query's parameters appended. */
export function auditQueryUrl(
  path: string,
  query: AuditQuery,
): { url: string; unsatisfiable: boolean } {
  const { params, unsatisfiable } = auditQuerySearchParams(query);
  const search = params.toString();
  return { url: search === '' ? path : `${path}?${search}`, unsatisfiable };
}
