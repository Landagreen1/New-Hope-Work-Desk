// Unit tests for the shared error contract.
//
// Feature: time-attendance-ui-redesign, task 7.2
//
// Two things are asserted, because they are the two ways a shared error contract
// stops being shared:
//
//   1. Each of the six failure shapes answers with the status and the body the
//      design's Error Handling table states. A screen branches on `code`, so a
//      403 without one, or a 409 without the current state, is a screen that has
//      to fall back to matching on prose.
//   2. A thrown service failure lands in its own shape. `not_visible` is a 403,
//      `invalid_range` is a 400 naming the field, `read_failed` is a 500, and a
//      throwable carrying no recognised code is a 500 whose message is ours
//      rather than the exception's.
//
// Requirements: 21.15, 22.16

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTHENTICATION_REQUIRED,
  ApiRequestError,
  FAILURE_KIND,
  FAILURE_STATUS,
  SUPABASE_UNCONFIGURED,
  apiOk,
  conflict,
  failed,
  failureKindOf,
  invalid,
  isApiFailureCode,
  serviceFailure,
  unauthenticated,
  unauthorised,
  unconfigured,
} from '../api-response';
import { AttendanceServiceError } from '../attendance-service';

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── The six shapes ──────────────────────────────────────────────────────────

describe('the six failure shapes', () => {
  it('answers Unconfigured with 503 and a message alone', async () => {
    const response = unconfigured();

    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toEqual({ error: SUPABASE_UNCONFIGURED });
  });

  it('answers Unauthenticated with 401 and a message alone', async () => {
    const response = unauthenticated();

    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toEqual({ error: AUTHENTICATION_REQUIRED });
  });

  it('answers Unauthorised with 403 and a code', async () => {
    const response = unauthorised('not_visible', 'That employee is outside your visibility.');

    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toEqual({
      error: 'That employee is outside your visibility.',
      code: 'not_visible',
    });
  });

  it('answers Invalid with 400, a code, and the offending field', async () => {
    const response = invalid('invalid_parameter', 'status: "sleeping" is not accepted.', 'status');

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({
      error: 'status: "sleeping" is not accepted.',
      code: 'invalid_parameter',
      field: 'status',
    });
  });

  it('omits the field when no single field is at fault', async () => {
    const body = await bodyOf(invalid('invalid_parameter', 'The request is unusable.'));

    expect(Object.hasOwn(body, 'field')).toBe(false);
  });

  it('answers Conflict with 409, a code, and the current server state', async () => {
    const current = { status: 'approved', decidedAt: '2026-08-10T13:00:00.000Z' };
    const response = conflict('stale_request_state', 'That request has already been decided.', current);

    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toEqual({
      error: 'That request has already been decided.',
      code: 'stale_request_state',
      current,
    });
  });

  it('answers Failed with 500, a code, and a reason a screen can display', async () => {
    const response = failed('read_failed');
    const body = await bodyOf(response);

    expect(response.status).toBe(500);
    expect(body.code).toBe('read_failed');
    // Requirement 22.16: a failed request states a reason, so the screen has
    // something to show beside its retry control.
    expect(String(body.error).length).toBeGreaterThan(0);
  });

  it('answers a successful read with 200', async () => {
    const response = apiOk({ records: [] });

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ records: [] });
  });
});

// ─── The code table ──────────────────────────────────────────────────────────

describe('the code table', () => {
  it('gives every code exactly one shape', () => {
    for (const code of Object.keys(FAILURE_KIND)) {
      expect(isApiFailureCode(code)).toBe(true);
      if (!isApiFailureCode(code)) continue;
      expect(FAILURE_STATUS[failureKindOf(code)]).toBeGreaterThanOrEqual(400);
    }
  });

  it('carries the five codes the design names', () => {
    for (const code of [
      'reason_required',
      'owner_cannot_decide',
      'coverage_shortfall',
      'already_clocked_in',
      'stale_request_state',
    ]) {
      expect(isApiFailureCode(code)).toBe(true);
    }
  });

  it('rejects a code outside the table', () => {
    expect(isApiFailureCode('nearly_right')).toBe(false);
    expect(isApiFailureCode(undefined)).toBe(false);
  });
});

// ─── Mapping a thrown failure ────────────────────────────────────────────────

describe('serviceFailure', () => {
  it('maps not_visible onto the Unauthorised shape', async () => {
    const response = serviceFailure(
      new AttendanceServiceError('not_visible', 'attendance: that employee is outside your visibility', {
        profileId: 'emp-b',
      }),
    );

    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toEqual({
      error: 'attendance: that employee is outside your visibility',
      code: 'not_visible',
    });
  });

  it('maps invalid_range onto the Invalid shape, naming the field from the detail', async () => {
    const response = serviceFailure(
      new AttendanceServiceError('invalid_range', 'attendance: from must be a calendar date', {
        field: 'from',
        value: '2026-02-30',
      }),
    );

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({
      error: 'attendance: from must be a calendar date',
      code: 'invalid_range',
      field: 'from',
    });
  });

  it('maps read_failed onto the Failed shape and keeps the service message', async () => {
    const response = serviceFailure(
      new AttendanceServiceError('read_failed', 'attendance: reading profiles failed: timeout', {
        table: 'profiles',
      }),
    );

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({
      error: 'attendance: reading profiles failed: timeout',
      code: 'read_failed',
    });
  });

  it('maps a request-parameter failure onto the Invalid shape with its own field', async () => {
    const response = serviceFailure(
      new ApiRequestError('invalid_parameter', 'saved_filter: "payrol_blocking" is not accepted.', 'saved_filter'),
    );

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({
      error: 'saved_filter: "payrol_blocking" is not accepted.',
      code: 'invalid_parameter',
      field: 'saved_filter',
    });
  });

  it('reports an unrecognised throwable as the fallback without leaking its message', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = new Error('connect ECONNREFUSED 10.0.0.4:5432 password=hunter2');

    const response = serviceFailure(raw);
    const body = await bodyOf(response);

    expect(response.status).toBe(500);
    expect(body.code).toBe('read_failed');
    expect(String(body.error)).not.toContain('hunter2');
    expect(String(body.error)).not.toContain('ECONNREFUSED');
    // The maintainer still gets it, on the server.
    expect(logged).toHaveBeenCalledWith('[time-attendance] unclassified failure', raw);
  });

  it('reports an unrecognised throwable on a mutation as a write failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const body = await bodyOf(serviceFailure(new Error('nope'), 'write_failed'));

    expect(body.code).toBe('write_failed');
    expect(String(body.error)).toContain('Nothing was saved.');
  });

  it('ignores a code it does not know rather than trusting it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // A thrown object claiming a code outside the table is a fault, not a
    // classified failure: honouring it would let any throwable pick its status.
    const response = serviceFailure({ code: 'teapot', message: 'brewing' });

    expect(response.status).toBe(500);
    expect(String((await bodyOf(response)).error)).not.toContain('brewing');
  });

  it('answers a conflict with a null current state rather than dropping the field', async () => {
    const body = await bodyOf(
      serviceFailure({ code: 'coverage_shortfall', message: 'Sales falls below minimum.' }),
    );

    expect(Object.hasOwn(body, 'current')).toBe(true);
    expect(body.current).toBeNull();
  });
});
