// src/features/time-attendance/server/__tests__/pto-routes.test.ts
// What `/api/pto` and `/api/pto/decisions` decide for themselves, which is the
// shape of the request and the shape of the answer.
//
// Feature: time-attendance-ui-redesign, task 12.3
//
// `resolveActor` needs a request scope and a Supabase session, so the handlers
// themselves are exercised by the integration tests, as `api-actor.test.ts`
// already notes. Everything the two routes do around the service is asserted here
// against the real parser, the real body readers, and the real failure contract.
// Nothing is mocked.
//
// Three things are asserted, because they are the three ways a route around a
// correct service still answers the wrong thing:
//
//   1. A filter the module does not accept is reported, not dropped. A dropped
//      `status=pendign` would answer with every request in the window while the
//      caller reads it as the pending ones.
//   2. A body value is read as the type it arrived as, never coerced.
//      `"acknowledged_shortfall": "false"` must not acknowledge a coverage
//      shortfall, and a malformed range must not be silently skipped.
//   3. The two answers a decision screen has to act on arrive in the shape it can
//      render: a stale view as 409 carrying the current row, and a refusal as 403
//      carrying its stable code (Requirements 10.17, 21.15, 22.16).
//
// The balance arithmetic, the guard, the replay, and the atomicity are the
// service's and the database's, and are task 12's starred tests.
//
// Requirements: 7.6, 7.7, 7.12, 10.1, 10.19, 10.20, 11.1, 11.6, 11.8, 21.15, 22.16

import { describe, expect, it } from 'vitest';

import { DECISION_OPTIONS, PTO_TYPE_TO_BALANCE_FIELD } from '../../domain/pto';
import { PTO_TYPE_LABELS } from '../../types';
import { ApiRequestError, serviceFailure } from '../api-response';
import { PTOServiceError } from '../pto-service';
import {
  optionalFlag,
  optionalRanges,
  readJsonBody,
  requiredBodyDate,
  requiredBodyRecordId,
  requiredChoice,
  requiredText,
  type JsonBody,
} from '../request-body';
import { PTO_STATUSES, PTO_TYPES, parseRequestQuery } from '../request-query';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const REQUEST_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function params(search: string): URLSearchParams {
  return new URL(`https://desk.test/api/pto${search}`).searchParams;
}

/** The `ApiRequestError` a read threw, or a failure if it did not throw. */
function rejection(read: () => unknown): ApiRequestError {
  try {
    read();
  } catch (error) {
    if (error instanceof ApiRequestError) return error;
    throw error;
  }
  throw new Error('expected the read to be rejected');
}

/** A JSON body as the route receives it. */
function posted(body: unknown): Request {
  return new Request('https://desk.test/api/pto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The response a thrown failure maps to, as a screen would read it. */
async function mapped(error: unknown): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = serviceFailure(error, 'write_failed');
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// ─── The accepted vocabularies ───────────────────────────────────────────────

describe('the request-type vocabulary', () => {
  it('is exactly the types the constraint accepts', () => {
    // Requirement 10, criterion 20. The route hands this list back so the
    // composer's selector cannot offer a type the database refuses, which is what
    // the inherited screen did with `birthday`.
    expect([...PTO_TYPES].sort()).toEqual(Object.keys(PTO_TYPE_TO_BALANCE_FIELD).sort());
    expect([...PTO_TYPES].sort()).toEqual(Object.keys(PTO_TYPE_LABELS).sort());
    expect(PTO_TYPES).not.toContain('birthday');
  });

  it('accepts every status a request can hold, so an employee can filter to any of them', () => {
    // Requirement 11, criterion 6: the employee's own list shows five states, and
    // the three extended decision statuses are legitimate filters too.
    for (const status of ['pending', 'approved', 'denied', 'cancelled', 'waitlisted']) {
      expect(PTO_STATUSES).toContain(status);
    }
  });
});

// ─── Parsing the inbox query ─────────────────────────────────────────────────

describe('parseRequestQuery', () => {
  it('reads the six filters and the paging', () => {
    expect(
      parseRequestQuery(
        params(
          '?status=pending,waitlisted&department=sales&profile_id=emp-a' +
            '&pto_type=vacation&from=2026-08-01&to=2026-08-31' +
            '&coverage_risk=critical&page=2&limit=25',
        ),
      ),
    ).toEqual({
      statuses: ['pending', 'waitlisted'],
      departments: ['sales'],
      profileIds: ['emp-a'],
      ptoTypes: ['vacation'],
      from: '2026-08-01',
      to: '2026-08-31',
      coverageRisks: ['critical'],
      page: 2,
      limit: 25,
    });
  });

  it('reads no filter at all from an empty query', () => {
    // An absent filter is an absent key, not `undefined`: a present key is an
    // active conjunct in `matchesRequestQuery`.
    expect(parseRequestQuery(params(''))).toEqual({});
    expect(parseRequestQuery(params('?status='))).toEqual({});
  });

  it('reads either end of the range alone', () => {
    // Unlike a coverage read: "requests from today onwards" is the default view of
    // a leave calendar, and the service resolves the missing end to its own
    // bounded window.
    expect(parseRequestQuery(params('?from=2026-08-01'))).toEqual({ from: '2026-08-01' });
    expect(parseRequestQuery(params('?to=2026-08-31'))).toEqual({ to: '2026-08-31' });
  });

  it('reports a status it does not recognise rather than dropping the filter', () => {
    const error = rejection(() => parseRequestQuery(params('?status=pendign')));

    expect(error.code).toBe('invalid_parameter');
    expect(error.field).toBe('status');
    expect(error.message).toContain('pendign');
  });

  it('reports a request type the constraint would refuse', () => {
    expect(rejection(() => parseRequestQuery(params('?pto_type=birthday')))).toMatchObject({
      code: 'invalid_parameter',
      field: 'pto_type',
    });
  });

  it('reports a malformed date and a page that is not a number', () => {
    expect(rejection(() => parseRequestQuery(params('?from=2026-02-30')))).toMatchObject({
      code: 'invalid_range',
      field: 'from',
    });
    expect(rejection(() => parseRequestQuery(params('?page=abc')))).toMatchObject({
      code: 'invalid_parameter',
      field: 'page',
    });
  });
});

// ─── Reading a body ──────────────────────────────────────────────────────────

describe('readJsonBody', () => {
  it('reads a JSON object', async () => {
    await expect(readJsonBody(posted({ action: 'cancel' }))).resolves.toEqual({
      action: 'cancel',
    });
  });

  it('refuses a body that is not a JSON object', async () => {
    // Reported as one invalid parameter rather than as several missing fields.
    for (const body of ['not json', JSON.stringify([{ action: 'cancel' }])]) {
      const request = new Request('https://desk.test/api/pto', { method: 'POST', body });
      await expect(readJsonBody(request)).rejects.toMatchObject({
        code: 'invalid_parameter',
        field: 'body',
      });
    }
  });
});

describe('the body readers', () => {
  it('requires an action and reports one it does not recognise', () => {
    const actions = ['submit', 'cancel'] as const;

    expect(requiredChoice({ action: 'submit' }, 'action', actions)).toBe('submit');
    expect(rejection(() => requiredChoice({}, 'action', actions))).toMatchObject({
      field: 'action',
    });
    expect(
      rejection(() => requiredChoice({ action: 'approve' }, 'action', actions)),
    ).toMatchObject({ field: 'action' });
  });

  it('accepts the eight decision options and nothing else', () => {
    for (const decision of DECISION_OPTIONS) {
      expect(requiredChoice({ decision }, 'decision', DECISION_OPTIONS)).toBe(decision);
    }
    expect(
      rejection(() => requiredChoice({ decision: 'approved' }, 'decision', DECISION_OPTIONS)),
    ).toMatchObject({ field: 'decision' });
  });

  it('treats a blank idempotency key as absent', () => {
    // A decision applies once per key, so a key of spaces would make every retry a
    // fresh decision (Requirement 10, criterion 17).
    expect(requiredText({ idempotency_key: 'k-1' }, 'idempotency_key')).toBe('k-1');
    expect(rejection(() => requiredText({ idempotency_key: '   ' }, 'idempotency_key'))).toMatchObject(
      { field: 'idempotency_key' },
    );
  });

  it('reads a flag only as a boolean', () => {
    // Acknowledging a coverage shortfall is a deliberate act. Reading `"false"` as
    // truthy is how a typo comes to mean yes.
    expect(optionalFlag({ acknowledged_shortfall: true }, 'acknowledged_shortfall')).toBe(true);
    expect(optionalFlag({}, 'acknowledged_shortfall')).toBeUndefined();
    expect(
      rejection(() => optionalFlag({ acknowledged_shortfall: 'false' }, 'acknowledged_shortfall')),
    ).toMatchObject({ field: 'acknowledged_shortfall' });
  });

  it('reads every range given, and reports one it cannot read', () => {
    const body: JsonBody = {
      approved_ranges: [
        { from: '2026-08-03', to: '2026-08-05' },
        { from: '2026-08-10', to: '2026-08-10' },
      ],
    };

    expect(optionalRanges(body, 'approved_ranges')).toEqual([
      { from: '2026-08-03', to: '2026-08-05' },
      { from: '2026-08-10', to: '2026-08-10' },
    ]);

    // Dropping the second entry would commit a different decision than the one the
    // administrator submitted.
    expect(
      rejection(() =>
        optionalRanges(
          { approved_ranges: [{ from: '2026-08-03', to: '2026-08-05' }, { from: '2026-08-10' }] },
          'approved_ranges',
        ),
      ),
    ).toMatchObject({ field: 'approved_ranges[1].to' });

    expect(optionalRanges({}, 'approved_ranges')).toBeUndefined();
    expect(optionalRanges({ approved_ranges: [] }, 'approved_ranges')).toEqual([]);
  });

  it('reads a nested field by its key and reports it by its label', () => {
    // How a coverage assignment is read: the lookup is the key the entry carries,
    // the message names the control the administrator can see.
    const entry: JsonBody = { date: '2026-08-03', covering_profile_id: REQUEST_ID };
    const label = 'coverage_assignments[0]';

    expect(requiredBodyDate(entry, 'date', `${label}.date`)).toBe('2026-08-03');
    expect(
      requiredBodyRecordId(entry, 'covering_profile_id', `${label}.covering_profile_id`),
    ).toBe(REQUEST_ID);
    expect(
      rejection(() => requiredText(entry, 'shift_start', `${label}.shift_start`)),
    ).toMatchObject({ field: 'coverage_assignments[0].shift_start' });
  });

  it('checks the shape of an identifier so a malformed one is a 400, not a 500', () => {
    expect(requiredBodyRecordId({ request_id: REQUEST_ID }, 'request_id')).toBe(REQUEST_ID);
    expect(rejection(() => requiredBodyRecordId({ request_id: 'abc' }, 'request_id'))).toMatchObject(
      { code: 'invalid_parameter', field: 'request_id' },
    );
  });
});

// ─── The answers a decision screen acts on ───────────────────────────────────

describe('the failure contract', () => {
  it('answers a stale view with 409 and the current row', async () => {
    const current = { requestId: REQUEST_ID, status: 'approved' };
    const { status, body } = await mapped(
      new PTOServiceError('stale_request_state', 'pto: the request moved to approved', {
        current,
      }),
    );

    expect(status).toBe(409);
    expect(body.code).toBe('stale_request_state');
    expect(body.current).toEqual(current);
  });

  it('answers a coverage shortfall with 409 and what it was read from', async () => {
    const { status, body } = await mapped(
      new PTOServiceError('coverage_shortfall', 'pto: approving this would leave staffing short', {
        current: { shortfalls: [{ workDate: '2026-08-03' }] },
      }),
    );

    expect(status).toBe(409);
    expect(body.code).toBe('coverage_shortfall');
    expect(body.current).toEqual({ shortfalls: [{ workDate: '2026-08-03' }] });
  });

  it('answers the owner of a request with 403 and its stable code', async () => {
    const { status, body } = await mapped(
      new PTOServiceError('owner_cannot_decide', 'pto: the employee who owns a request may not decide it'),
    );

    expect(status).toBe(403);
    expect(body.code).toBe('owner_cannot_decide');
  });

  it('names the field a refused body value came from', async () => {
    const { status, body } = await mapped(
      new ApiRequestError('invalid_parameter', 'decision is required', 'decision'),
    );

    expect(status).toBe(400);
    expect(body).toMatchObject({ code: 'invalid_parameter', field: 'decision' });
  });
});
