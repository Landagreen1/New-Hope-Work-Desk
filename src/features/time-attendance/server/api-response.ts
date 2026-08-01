// src/features/time-attendance/server/api-response.ts
// The one error contract every Time & Attendance endpoint answers with.
//
// The design's Error Handling section names six failure shapes. They are written
// here once, as data plus six builders, because a screen can only have a single
// error contract to render if the routes have a single error contract to emit.
// Four screens reading six ad-hoc shapes is how `error.message` string matching
// starts.
//
// | Kind            | Status | Body                       | Screen behaviour                        |
// | --------------- | ------ | -------------------------- | --------------------------------------- |
// | Unconfigured    | 503    | `{ error }`                | Full-panel message, no retry            |
// | Unauthenticated | 401    | `{ error }`                | Redirect to sign-in                     |
// | Unauthorised    | 403    | `{ error, code }`          | Reason in place of the content          |
// | Invalid         | 400    | `{ error, code, field? }`  | Inline message on the offending field   |
// | Conflict        | 409    | `{ error, code, current }` | Message plus the current server state   |
// | Failed          | 500    | `{ error, code }`          | Reason plus a retry control             |
//
// ## Why `code` exists
//
// `code` is a stable machine-readable string. It is what lets a screen tell a
// recoverable conflict from a hard failure without matching on prose, and it is
// what makes the failure text translatable later without breaking the screens.
// Every shape that a screen has to branch on carries one; the two shapes a screen
// cannot act on — Unconfigured and Unauthenticated — carry only a message,
// because there is nothing to branch on.
//
// ## Why the code-to-kind table is data
//
// `FAILURE_KIND` is the whole mapping, and the per-kind code unions are derived
// from it. Adding a code is one row, and a route that emits a code under the
// wrong kind — a `reason_required` as a 409, say — does not compile. The
// alternative, a status number written at each `Response.json` call, drifts the
// first time two endpoints disagree about which status a shortfall is.
//
// ## Mapping a service failure
//
// `serviceFailure` translates a thrown error into its shape by reading the
// `code` the service put on it. `AttendanceServiceError` codes map as the design
// states: `not_visible` to 403, `invalid_range` to 400, `read_failed` to 500. A
// throwable carrying no recognised code is a fault rather than a classified
// failure, so it is logged and reported as the caller's fallback without its
// message reaching the client.
//
// Consumed by the read routes now, and by `/api/coverage`, `/api/pto`,
// `/api/attendance/corrections`, `/api/attendance/notes`,
// `/api/attendance/reviews`, `/api/attendance/export`, and
// `/api/attendance/inbox` as those land.
//
// Requirements: 21.15 (a request outside the permitted set returns an
// authorisation failure and changes nothing), 22.16 (a failed request states its
// reason so a screen can display it beside a retry control).

/** The six failure shapes, by name. */
export type FailureKind =
  | 'unconfigured'
  | 'unauthenticated'
  | 'unauthorised'
  | 'invalid'
  | 'conflict'
  | 'failed';

/** The HTTP status each shape answers with. */
export const FAILURE_STATUS: Readonly<Record<FailureKind, number>> = {
  unconfigured: 503,
  unauthenticated: 401,
  unauthorised: 403,
  invalid: 400,
  conflict: 409,
  failed: 500,
};

/**
 * Every failure code the module emits, and the shape each one is answered in.
 *
 * The five the design names — `reason_required`, `owner_cannot_decide`,
 * `coverage_shortfall`, `already_clocked_in`, `stale_request_state` — are here
 * with the codes the read and authorisation paths need, because the 403, 400,
 * 409, and 500 shapes all carry a `code` and none of them may invent one.
 *
 * - `not_authorised` — the signed-in user holds no role that permits the call.
 * - `not_visible` — the record exists but lies outside the caller's visibility.
 * - `owner_cannot_decide` — an employee tried to decide their own request.
 * - `invalid_parameter` — a query or body value the module does not accept.
 * - `invalid_range` — a malformed, inverted, or over-wide date range.
 * - `reason_required` — a manual override arrived without a stored reason.
 * - `coverage_shortfall` — an approval would leave a date below minimum staffing
 *   and no escape (assigned coverage, acknowledgement, override reason) applies.
 * - `stale_request_state` — the target moved between the read and the write.
 * - `already_clocked_in` — a second open clock entry was attempted. Retained
 *   because it is part of the named contract; `/api/time-clock` answers the race
 *   it describes with `200` and `already_open: true`, since the caller's intent
 *   was to be clocked in and they are.
 * - `read_failed` — a source read failed. Not the same as an empty result: row
 *   level security answers an unpermitted read with no rows, not an error.
 * - `write_failed` — a mutation failed for a reason with no more specific code.
 * - `audit_write_failed` — the audit insert raised, so the transaction rolled
 *   back and the source row is unchanged.
 */
export const FAILURE_KIND = {
  not_authorised: 'unauthorised',
  not_visible: 'unauthorised',
  owner_cannot_decide: 'unauthorised',
  invalid_parameter: 'invalid',
  invalid_range: 'invalid',
  reason_required: 'invalid',
  coverage_shortfall: 'conflict',
  stale_request_state: 'conflict',
  already_clocked_in: 'conflict',
  read_failed: 'failed',
  write_failed: 'failed',
  audit_write_failed: 'failed',
} as const satisfies Readonly<Record<string, FailureKind>>;

export type ApiFailureCode = keyof typeof FAILURE_KIND;

/** The codes answered in one shape. */
type CodesOfKind<K extends FailureKind> = {
  [C in ApiFailureCode]: (typeof FAILURE_KIND)[C] extends K ? C : never;
}[ApiFailureCode];

export type UnauthorisedCode = CodesOfKind<'unauthorised'>;
export type InvalidCode = CodesOfKind<'invalid'>;
export type ConflictCode = CodesOfKind<'conflict'>;
export type FailedCode = CodesOfKind<'failed'>;

/** The shape a code is answered in. */
export function failureKindOf(code: ApiFailureCode): FailureKind {
  return FAILURE_KIND[code];
}

export function isApiFailureCode(value: unknown): value is ApiFailureCode {
  return typeof value === 'string' && Object.hasOwn(FAILURE_KIND, value);
}

// ─── Response bodies ─────────────────────────────────────────────────────────

export interface UnconfiguredBody {
  error: string;
}

export interface UnauthenticatedBody {
  error: string;
}

export interface UnauthorisedBody {
  error: string;
  code: UnauthorisedCode;
}

export interface InvalidBody {
  error: string;
  code: InvalidCode;
  /** The offending parameter or field, when one can be named. */
  field?: string;
}

export interface ConflictBody {
  error: string;
  code: ConflictCode;
  /** The current server state, so the caller can retry against fresh data. */
  current: unknown;
}

export interface FailedBody {
  error: string;
  code: FailedCode;
}

export type ApiFailureBody =
  | UnconfiguredBody
  | UnauthenticatedBody
  | UnauthorisedBody
  | InvalidBody
  | ConflictBody
  | FailedBody;

// ─── Default messages ────────────────────────────────────────────────────────

export const SUPABASE_UNCONFIGURED = 'Supabase is not configured.';
export const AUTHENTICATION_REQUIRED = 'Authentication required.';

/**
 * What a caller is told when a throwable carries no recognised code.
 *
 * Deliberately not the exception's own message: an unclassified throwable is as
 * likely to be a driver or connection message as anything a user can act on, and
 * a message written for a maintainer does not belong in a screen. The exception
 * itself goes to the server log, where a maintainer can read it.
 */
const FALLBACK_MESSAGE: Readonly<Record<FailedCode, string>> = {
  read_failed: 'That attendance read could not be completed. Retrying may succeed.',
  write_failed: 'That change could not be completed. Nothing was saved.',
  audit_write_failed: 'That change was rolled back because its audit entry could not be recorded.',
};

// ─── The six builders ────────────────────────────────────────────────────────

/** 503. The deployment has no Supabase configuration; retrying will not help. */
export function unconfigured(error: string = SUPABASE_UNCONFIGURED): Response {
  return Response.json({ error } satisfies UnconfiguredBody, {
    status: FAILURE_STATUS.unconfigured,
  });
}

/** 401. No signed-in user. */
export function unauthenticated(error: string = AUTHENTICATION_REQUIRED): Response {
  return Response.json({ error } satisfies UnauthenticatedBody, {
    status: FAILURE_STATUS.unauthenticated,
  });
}

/**
 * 403. The caller is signed in and the call is outside their permitted set.
 *
 * The message states what was refused rather than what exists, so a refusal
 * cannot confirm the presence of a record the caller may not see.
 */
export function unauthorised(code: UnauthorisedCode, error: string): Response {
  return Response.json({ error, code } satisfies UnauthorisedBody, {
    status: FAILURE_STATUS.unauthorised,
  });
}

/** 400. A parameter or field the module does not accept. `field` names it. */
export function invalid(code: InvalidCode, error: string, field?: string): Response {
  const body: InvalidBody = field === undefined ? { error, code } : { error, code, field };
  return Response.json(body, { status: FAILURE_STATUS.invalid });
}

/** 409. The target moved, or a guard applies. `current` is the fresh state. */
export function conflict(code: ConflictCode, error: string, current: unknown = null): Response {
  return Response.json({ error, code, current } satisfies ConflictBody, {
    status: FAILURE_STATUS.conflict,
  });
}

/** 500. The call failed for a reason the caller may retry. */
export function failed(code: FailedCode, error: string = FALLBACK_MESSAGE[code]): Response {
  return Response.json({ error, code } satisfies FailedBody, { status: FAILURE_STATUS.failed });
}

// ─── Success ─────────────────────────────────────────────────────────────────

/**
 * 200 with a JSON body.
 *
 * Route handlers are uncached in this version of Next.js and these reads are
 * per-user and row-level-security scoped, so nothing here opts into caching.
 */
export function apiOk<T>(body: T): Response {
  return Response.json(body, { status: 200 });
}

// ─── A parameter the module will not accept ───────────────────────────────────

/**
 * A request parameter that failed validation, carrying the field it came from.
 *
 * Thrown by the query parsers and answered as the Invalid shape, so a route body
 * is one `try` around parse-and-read rather than a branch per parameter.
 */
export class ApiRequestError extends Error {
  readonly code: InvalidCode;
  readonly field: string | undefined;

  constructor(code: InvalidCode, message: string, field?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.field = field;
  }
}

// ─── Mapping a thrown failure onto its shape ─────────────────────────────────

/** What a coded throwable told us. */
interface CodedFailure {
  code: ApiFailureCode;
  message: string;
  field: string | undefined;
  current: unknown;
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * The failure a throwable describes, or null when it describes none.
 *
 * `field` and `current` are read from the error's own properties and from a
 * `detail` bag, because the services carry supporting facts in both shapes:
 * `AttendanceServiceError` puts them in `detail`, `ApiRequestError` puts the
 * field on itself, and a decision failure carries the current row.
 */
function readCodedFailure(error: unknown): CodedFailure | null {
  if (typeof error !== 'object' || error === null) return null;

  const source = error as Record<string, unknown>;
  if (!isApiFailureCode(source.code)) return null;

  const detail =
    typeof source.detail === 'object' && source.detail !== null
      ? (source.detail as Record<string, unknown>)
      : undefined;

  return {
    code: source.code,
    message: readText(source.message) ?? FALLBACK_MESSAGE.read_failed,
    field: readText(source.field) ?? readText(detail?.field),
    current: Object.hasOwn(source, 'current') ? source.current : (detail ?? null),
  };
}

/**
 * The response for a thrown failure.
 *
 * A recognised code is answered in its own shape and keeps its message, because
 * the services author those messages for a reader. Anything else is a fault: it
 * is logged and answered as `fallback` with a generic message, so a driver
 * message never reaches a screen.
 *
 * `fallback` is `read_failed` for a read route and `write_failed` for a mutation,
 * which is the honest answer about which half of the request gave way.
 *
 * Requirements: 21.15, 22.16
 */
export function serviceFailure(error: unknown, fallback: FailedCode = 'read_failed'): Response {
  const coded = readCodedFailure(error);

  if (coded === null) {
    console.error('[time-attendance] unclassified failure', error);
    return failed(fallback);
  }

  switch (FAILURE_KIND[coded.code]) {
    case 'unauthorised':
      return unauthorised(coded.code as UnauthorisedCode, coded.message);
    case 'invalid':
      return invalid(coded.code as InvalidCode, coded.message, coded.field);
    case 'conflict':
      return conflict(coded.code as ConflictCode, coded.message, coded.current);
    case 'failed':
      return failed(coded.code as FailedCode, coded.message);
  }
}
