// src/features/time-attendance/shared/api-failure.ts
// The reading half of the module's error contract.
//
// `server/api-response.ts` writes six failure shapes, each carrying a stable
// `code` and a message, and a 409 carrying the current server state. This module
// reads them back, once, so that a screen displaying a reason beside a retry
// control (Requirement 22, criterion 16) never has to look at an HTTP status or
// match on prose to decide what happened.
//
// The legacy screens are what this replaces. `TimeClock.tsx`, `PTORequests.tsx`,
// and `ScheduleManager.tsx` each contain a variant of
//
// ```ts
// if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || 'Failed.'); }
// ```
//
// which throws away the `code`, throws away the 409's `current`, and leaves the
// screen with a string it can only render. A screen cannot tell a recoverable
// conflict from a hard failure that way, and it cannot tell a refusal it should
// not offer to retry from one it should.
//
// ## What a caller gets
//
// One `ApiFailure`, always, whatever went wrong:
//
// | went wrong                        | `kind`            | `code`   | `status` |
// | --------------------------------- | ----------------- | -------- | -------- |
// | a coded failure body              | from `FAILURE_KIND` | the code | as sent  |
// | an uncoded 401 or 403             | from the status   | `null`   | as sent  |
// | an HTML error page from a proxy   | from the status   | `null`   | as sent  |
// | the request never left the tab    | `failed`          | `null`   | `0`      |
//
// `code === null` means the body carried no code the module recognises, and
// `status === 0` means the request never reached the server. Both still carry a
// `reason` in words, because a screen has to render something either way.
//
// ## Why the code table is imported rather than restated
//
// `FAILURE_KIND` in `server/api-response.ts` is the whole mapping from a code to
// the shape it is answered in. Importing it means a code added there is
// classified here without a second edit, and a client-side copy of that table
// cannot drift out of step with the routes. Only the table and the two type
// guards are used; the response builders are unreachable from the browser and
// drop out of the bundle. Nothing in that module imports anything, so no server
// code follows it across.
//
// Requirements: 5.20, 22.16

import {
  FAILURE_KIND,
  isApiFailureCode,
  type ApiFailureCode,
  type FailureKind,
} from '../server/api-response';

/**
 * One failure, in the terms a screen renders.
 *
 * `reason` is the message the route wrote where there was one, because those are
 * authored for a reader. Where there was none, it is this module's sentence for
 * that shape rather than a driver message or a bare status number.
 */
export interface ApiFailure {
  /** Which of the six shapes this is. */
  kind: FailureKind;
  /** The stable code the body carried, or null when it carried none. */
  code: ApiFailureCode | null;
  /** The HTTP status, or 0 when the request never reached the server. */
  status: number;
  /** The reason, as text a screen can display. Never empty. */
  reason: string;
  /** The field a 400 named, when it named one. */
  field: string | undefined;
  /** The current server state a 409 carries, so a caller can retry against it. */
  current: unknown;
  /** Whether repeating the same request could plausibly succeed. */
  retryable: boolean;
}

/**
 * Whether retrying the same request could help.
 *
 * A conflict is retryable because the contract hands back `current` precisely so
 * the caller can try again against fresh state. A refusal, a malformed request,
 * and an unconfigured deployment are not: the same request will be refused the
 * same way, and offering a retry control invites a reader to press it until they
 * conclude the screen is broken. This is the same division
 * `server/api-response.ts` records in its own table.
 */
const RETRYABLE: Readonly<Record<FailureKind, boolean>> = {
  unconfigured: false,
  unauthenticated: false,
  unauthorised: false,
  invalid: false,
  conflict: true,
  failed: true,
};

/**
 * What a reader is told when the body named no reason.
 *
 * One sentence per shape, stating what happened and what to do about it. These
 * are fallbacks: a route that wrote its own message keeps it.
 */
const KIND_REASON: Readonly<Record<FailureKind, string>> = {
  unconfigured: 'This deployment is not configured to answer that request.',
  unauthenticated: 'Your session has ended. Sign in again to continue.',
  unauthorised: 'You do not have access to that.',
  invalid: 'That request could not be understood, so nothing was changed.',
  conflict: 'That record changed before this request arrived. Reload to see its current state.',
  failed: 'That request could not be completed. Trying again may succeed.',
};

/** The request never reached the server: offline, blocked, or a dropped connection. */
const TRANSPORT_REASON =
  'That request could not reach the server. Check your connection and try again.';

/** A 200 whose body was not the JSON the caller expected. */
const UNREADABLE_BODY_REASON =
  'The server answered in a form this screen could not read. Trying again may succeed.';

/**
 * The shape an uncoded status belongs to.
 *
 * Used only when the body carried no recognised code — an error page from a
 * proxy, a 404 from a mistyped path, a 502 from in front of the app. The four
 * statuses the contract assigns a meaning to are mapped to it; anything else
 * falls to the nearest of `invalid` and `failed`, so a 4xx is never presented as
 * something a retry will fix.
 */
export function failureKindForStatus(status: number): FailureKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'unauthorised';
  if (status === 409) return 'conflict';
  if (status === 503) return 'unconfigured';
  if (status >= 400 && status < 500) return 'invalid';
  return 'failed';
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** The body as an object, or null when it was absent, empty, or not JSON. */
async function readJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A failure built from its parts, with `retryable` derived rather than passed. */
function buildFailure(parts: Omit<ApiFailure, 'retryable'>): ApiFailure {
  return { ...parts, retryable: RETRYABLE[parts.kind] };
}

/**
 * The failure a non-2xx response describes.
 *
 * The `code` in the body decides the shape where there is one, because the code
 * is what the contract fixes; the status is the fallback. A body claiming a code
 * under the wrong status is therefore read the way the route meant it, which
 * matters for the one place the two disagree by design: `/api/time-clock`
 * answers the clock-in race with a 200 rather than the `already_clocked_in` 409.
 *
 * Requirements: 22.16
 */
export async function apiFailureOf(response: Response): Promise<ApiFailure> {
  const body = await readJsonBody(response);
  const code = isApiFailureCode(body?.code) ? body.code : null;
  const kind = code === null ? failureKindForStatus(response.status) : FAILURE_KIND[code];

  return buildFailure({
    kind,
    code,
    status: response.status,
    reason: text(body?.error) ?? KIND_REASON[kind],
    field: text(body?.field),
    current: body !== null && Object.hasOwn(body, 'current') ? body.current : null,
  });
}

/** The failure for a request that never reached the server. */
export function transportFailure(reason: string = TRANSPORT_REASON): ApiFailure {
  return buildFailure({
    kind: 'failed',
    code: null,
    status: 0,
    reason,
    field: undefined,
    current: null,
  });
}

/**
 * A read or write that failed, carrying the failure it failed with.
 *
 * Thrown rather than returned so a fetcher stays a plain `Promise<T>` and a
 * screen's happy path holds no failure branch. `useAsyncResource` catches it.
 */
export class ApiFailureError extends Error {
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure) {
    super(failure.reason);
    this.name = 'ApiFailureError';
    this.failure = failure;
  }
}

/**
 * Whether a throwable is an abort rather than a failure.
 *
 * An aborted request is one the module itself cancelled — a filter changed, a
 * poll superseded it, the screen unmounted — so it is not something to report to
 * a reader. `fetch` rejects with a `DOMException` named `AbortError`, which is
 * checked by name because `DOMException` is not a global in every environment
 * this code is type-checked in.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * The failure any throwable describes.
 *
 * An `ApiFailureError` carries its own; anything else is treated as a transport
 * failure, because a throwable reaching here that is not one of ours came from
 * `fetch` or from the surrounding runtime, and neither produces a message worth
 * putting on a screen. The throwable itself goes to the console for a maintainer.
 */
export function asApiFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailureError) return error.failure;
  console.error('[time-attendance] request failed', error);
  return transportFailure();
}

/** A JSON request body, with the header that goes with it. */
export function jsonRequest(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * A JSON read or write against a module endpoint.
 *
 * Resolves with the parsed body on success and throws `ApiFailureError` on
 * anything else, so every screen reaches the contract through one function. An
 * abort is re-thrown untouched for `isAbortError` to recognise: it is the
 * module's own cancellation, not a failure.
 *
 * ```ts
 * const day = useAttendancePoll(
 *   (signal) => attendanceJson<DayResponse>(`/api/attendance/day?date=${date}`, { signal }),
 *   { deps: [date], filters: [{ label: 'Date', value: date }] },
 * );
 * ```
 *
 * Requirements: 22.16
 */
export async function attendanceJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.error('[time-attendance] request could not be sent', url, error);
    throw new ApiFailureError(transportFailure());
  }

  if (!response.ok) throw new ApiFailureError(await apiFailureOf(response));

  try {
    return (await response.json()) as T;
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.error('[time-attendance] response body could not be read', url, error);
    throw new ApiFailureError(
      buildFailure({
        kind: 'failed',
        code: null,
        status: response.status,
        reason: UNREADABLE_BODY_REASON,
        field: undefined,
        current: null,
      }),
    );
  }
}
