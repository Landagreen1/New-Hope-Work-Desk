/**
 * Typed HTTP responses for the carrier submission routes.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirement 10.9.
 *
 * The codebase has four competing API auth/response patterns. This module follows the
 * shape of the most disciplined of them — Time & Attendance's `api-response.ts`, where a
 * code and its HTTP status are declared together so a code cannot be returned under the
 * wrong status.
 *
 * It does NOT import that module. Doing so would mean adding carrier-submission codes to
 * the attendance feature's registry, coupling two unrelated features through a shared
 * enum that neither owns. The duplication here is about forty lines and buys independence.
 */

/** Code → HTTP status. The single source of truth for both. */
export const FAILURE_STATUS = {
  unconfigured: 503,
  unauthenticated: 401,
  not_a_sender: 403,
  not_authorised: 403,
  invalid_request: 400,
  no_connection: 409,
  needs_reconnect: 409,
  duplicate_send: 409,
  provider_failed: 502,
  read_failed: 500,
  write_failed: 500,
} as const;

export type FailureCode = keyof typeof FAILURE_STATUS;

export interface FailureBody {
  error: string;
  code: FailureCode;
  /** Present on validation failures so a form can highlight the offending control. */
  field?: string;
  /** Present when a retry might succeed, so the UI can offer one honestly. */
  retryable?: boolean;
}

export function fail(
  code: FailureCode,
  error: string,
  extra?: { field?: string; retryable?: boolean },
): Response {
  const body: FailureBody = { error, code, ...extra };
  return Response.json(body, { status: FAILURE_STATUS[code] });
}

export function ok<T>(body: T): Response {
  return Response.json(body, { status: 200 });
}

export const MESSAGES = {
  unconfigured: 'The Work Desk is not configured for email submission.',
  unauthenticated: 'Sign in to continue.',
  notASender:
    'Sending carrier submissions is not enabled for your account. A manager can enable it.',
  noConnection: 'Connect your mailbox before sending a submission.',
  needsReconnect:
    'Your mailbox connection has expired or was revoked. Reconnect it in your settings.',
} as const;
