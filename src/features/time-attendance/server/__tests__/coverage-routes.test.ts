// Unit tests for what `/api/coverage` and `/api/coverage/impact` are assembled
// from: the query parsing, and the mapping from a failed read to a response.
//
// Feature: time-attendance-ui-redesign, task 9.2
//
// `resolveActor` needs a request scope and a Supabase session, so the handler
// functions themselves are exercised by the integration tests, as
// `api-actor.test.ts` already notes. Everything the two routes do after the
// caller is resolved is asserted here against the real parser, the real coverage
// reads, and the real failure contract. Nothing in the module is mocked; the
// Supabase client is a stand-in for the database that answers with a fixed result
// and records the tables it was asked for.
//
// Three things are asserted, because they are the three ways a route around a
// correct service still answers the wrong thing:
//
//   1. A parameter the module does not accept is reported, not defaulted. A
//      dropped `mode` would answer with expected coverage while the caller reads
//      it as current coverage; a half-given range would answer about a narrower
//      span than the one asked for.
//   2. A failure arrives in the shape a screen can render: the status, the stable
//      `code`, and the field where there is one (Requirements 21.15, 22.16).
//   3. Nothing is read before the query is judged, so a malformed request costs
//      no source read.
//
// The per-date `unavailable: { reason }` contract is task 9.3's to test.
//
// Requirements: 6.15, 8.12, 9.1, 9.14, 20.4, 21.15, 22.16

import { describe, expect, it } from 'vitest';

import { addCalendarDays } from '../../domain/work-date';
import { ApiRequestError, apiOk, serviceFailure } from '../api-response';
import type { AttendanceClient } from '../attendance-service';
import { getCoverage, getImpact, type CoverageQuery } from '../coverage-service';
import { parseCoverageQuery, requiredRecordId } from '../request-query';
import type { Actor } from '../visibility';

// ─── A database stand-in ─────────────────────────────────────────────────────

interface QueryResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

/** A query that ignores its filters and answers with one fixed result. */
class FixedQuery {
  constructor(private readonly result: QueryResult) {}

  select(): this {
    return this;
  }
  order(): this {
    return this;
  }
  eq(): this {
    return this;
  }
  in(): this {
    return this;
  }
  gte(): this {
    return this;
  }
  lte(): this {
    return this;
  }
  lt(): this {
    return this;
  }

  /** The first matching row, or null, as the real client answers a single read. */
  maybeSingle(): Promise<QueryResult> {
    const { data, error } = this.result;
    return Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error });
  }

  then<TResult1, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

interface Stand {
  client: AttendanceClient;
  /** Every table asked for, in order. One entry per outbound query. */
  tables: string[];
}

function standAnswering(result: QueryResult): Stand {
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      return new FixedQuery(result);
    },
  };
  return { client: client as unknown as AttendanceClient, tables };
}

/** Every read succeeds and every table is empty. */
function emptyStand(): Stand {
  return standAnswering({ data: [], error: null });
}

/** Every read fails. */
function failingStand(): Stand {
  return standAnswering({ data: null, error: { message: 'connection reset', code: '08006' } });
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADMIN: Actor = { id: 'admin-1', role: 'super_admin' };
const EMPLOYEE: Actor = { id: 'emp-b', role: 'customer_service' };

/** Today in the business timezone, as the route resolves it before parsing. */
const TODAY = '2026-08-10';
const AFTERNOON_AT = '2026-08-10T18:00:00.000Z';
const REQUEST_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function params(search: string): URLSearchParams {
  return new URL(`https://desk.test/api/coverage${search}`).searchParams;
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

/** The body of the response a thrown failure maps to, with its status. */
async function mapped(
  read: () => Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await read();
  } catch (error) {
    const response = serviceFailure(error);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  throw new Error('expected the read to fail');
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

describe('parseCoverageQuery', () => {
  it('reads the mode, the range, and the department filter', () => {
    expect(
      parseCoverageQuery(
        params('?mode=projected&from=2026-08-01&to=2026-08-31&department=sales'),
        TODAY,
      ),
    ).toEqual({
      mode: 'projected',
      from: '2026-08-01',
      to: '2026-08-31',
      department: 'sales',
    });
  });

  it('accepts both modes', () => {
    expect(parseCoverageQuery(params('?mode=live'), TODAY).mode).toBe('live');
    expect(parseCoverageQuery(params('?mode=projected'), TODAY).mode).toBe('projected');
  });

  it('requires the mode rather than choosing a figure for the caller', () => {
    // A defaulted mode would answer with expected coverage while the caller reads
    // it as current coverage, or the reverse. They are different questions.
    const error = rejection(() =>
      parseCoverageQuery(params('?from=2026-08-01&to=2026-08-31'), TODAY),
    );

    expect(error.code).toBe('invalid_parameter');
    expect(error.field).toBe('mode');
    expect(error.message).toContain('live');
    expect(error.message).toContain('projected');
  });

  it('rejects a mode it does not recognise', () => {
    const error = rejection(() => parseCoverageQuery(params('?mode=current'), TODAY));

    expect(error.field).toBe('mode');
    expect(error.message).toContain('current');
  });

  it('resolves an absent range to the date the caller was given', () => {
    expect(parseCoverageQuery(params('?mode=live'), TODAY)).toEqual({
      mode: 'live',
      from: TODAY,
      to: TODAY,
    });
  });

  it('reports a half-given range by naming the missing end', () => {
    // Completing it silently would answer about a narrower span than the one
    // asked for, and the caller would read the answer as the whole span.
    expect(
      rejection(() => parseCoverageQuery(params('?mode=projected&from=2026-08-01'), TODAY)),
    ).toMatchObject({ code: 'invalid_range', field: 'to' });
    expect(
      rejection(() => parseCoverageQuery(params('?mode=projected&to=2026-08-31'), TODAY)),
    ).toMatchObject({ code: 'invalid_range', field: 'from' });
  });

  it('rejects a malformed date and a date that names no day', () => {
    expect(
      rejection(() =>
        parseCoverageQuery(params('?mode=projected&from=2026-8-1&to=2026-08-31'), TODAY),
      ).field,
    ).toBe('from');
    expect(
      rejection(() =>
        parseCoverageQuery(params('?mode=projected&from=2026-02-01&to=2026-02-30'), TODAY),
      ).code,
    ).toBe('invalid_range');
  });

  it('takes one department, not a list', () => {
    // A coverage read restricts the roster to one department. Two names is two
    // questions, and answering one of them silently answers neither.
    const error = rejection(() =>
      parseCoverageQuery(params('?mode=projected&department=sales,commercial'), TODAY),
    );

    expect(error.field).toBe('department');
    expect(error.message).toContain('one value');
  });

  it('rejects a department it does not recognise', () => {
    expect(
      rejection(() => parseCoverageQuery(params('?mode=live&department=legal'), TODAY)).field,
    ).toBe('department');
  });

  it('treats a cleared department control as an absent filter', () => {
    const query = parseCoverageQuery(params('?mode=live&department='), TODAY);

    expect(Object.hasOwn(query, 'department')).toBe(false);
  });

  it('accepts no proposed absence from a query string', () => {
    // The absence an impact preview costs comes from the stored request. A caller
    // able to name one here could have the server project a hypothetical absence
    // for any employee.
    const query: CoverageQuery = parseCoverageQuery(
      params('?mode=projected&proposed_absence=emp-a&profile_id=emp-a'),
      TODAY,
    );

    expect(query.proposedAbsence).toBeUndefined();
    expect(query).toEqual({ mode: 'projected', from: TODAY, to: TODAY });
  });
});

// ─── The impact preview's parameter ──────────────────────────────────────────

describe('requiredRecordId', () => {
  it('reads a stored record identifier', () => {
    expect(requiredRecordId(params(`?request_id=${REQUEST_ID}`), 'request_id')).toBe(REQUEST_ID);
  });

  it('reports an absent request_id by name', () => {
    const error = rejection(() => requiredRecordId(params(''), 'request_id'));

    expect(error.code).toBe('invalid_parameter');
    expect(error.field).toBe('request_id');
  });

  it('reports a value that is not a record identifier as an invalid parameter', () => {
    // Left to reach Postgres it comes back as an invalid-uuid error, which the
    // failure contract can only answer as a retryable 500 — the wrong answer for
    // an input retrying can never fix.
    const error = rejection(() => requiredRecordId(params('?request_id=req-a'), 'request_id'));

    expect(error.code).toBe('invalid_parameter');
    expect(error.field).toBe('request_id');
    expect(error.message).toContain('req-a');
  });
});

// ─── Failure mapping ─────────────────────────────────────────────────────────

describe('the response a failed coverage read maps to', () => {
  const context = (stand: Stand) => ({ client: stand.client, evaluatedAt: AFTERNOON_AT });

  it('answers a live read over more than one date as an invalid request', async () => {
    const stand = emptyStand();
    const { status, body } = await mapped(() =>
      getCoverage(ADMIN, { from: TODAY, to: '2026-08-11', mode: 'live' }, context(stand)),
    );

    expect(status).toBe(400);
    expect(body.code).toBe('invalid_range');
    expect(body.error).toContain('single date');
    // Nothing was read: the range is judged before any source query.
    expect(stand.tables).toEqual([]);
  });

  it('answers an inverted range as an invalid request', async () => {
    const stand = emptyStand();
    const inverted: CoverageQuery = { from: '2026-08-31', to: '2026-08-01', mode: 'projected' };
    const { status, body } = await mapped(() => getCoverage(ADMIN, inverted, context(stand)));

    expect(status).toBe(400);
    expect(body.code).toBe('invalid_range');
    expect(stand.tables).toEqual([]);
  });

  it('answers a range wider than the read cap as an invalid request', async () => {
    const stand = emptyStand();
    const { status, body } = await mapped(() =>
      getCoverage(
        ADMIN,
        { from: '2026-01-01', to: addCalendarDays('2026-01-01', 500), mode: 'projected' },
        context(stand),
      ),
    );

    expect(status).toBe(400);
    expect(body.code).toBe('invalid_range');
    expect(stand.tables).toEqual([]);
  });

  it('answers a parse rejection as an invalid request naming the field', async () => {
    const { status, body } = await mapped(async () =>
      parseCoverageQuery(params('?mode=projected&from=2026-08-01'), TODAY),
    );

    expect(status).toBe(400);
    expect(body).toEqual({
      error: expect.stringContaining('to'),
      code: 'invalid_range',
      field: 'to',
    });
  });

  it('answers a request the caller may not see as an authorisation failure', async () => {
    const stand = emptyStand();
    const { status, body } = await mapped(() => getImpact(EMPLOYEE, REQUEST_ID, context(stand)));

    expect(status).toBe(403);
    expect(body.code).toBe('not_visible');
    // The refusal does not confirm whether the request exists.
    expect(body.error).not.toContain('exist');
  });

  it('answers a request that does not exist identically', async () => {
    const stand = emptyStand();
    const { status, body } = await mapped(() => getImpact(ADMIN, REQUEST_ID, context(stand)));

    expect(status).toBe(403);
    expect(body.code).toBe('not_visible');
  });

  it('answers a failed source read as a retryable failure', async () => {
    const stand = failingStand();
    const { status, body } = await mapped(() =>
      getCoverage(ADMIN, { from: TODAY, to: TODAY, mode: 'projected' }, context(stand)),
    );

    expect(status).toBe(500);
    expect(body.code).toBe('read_failed');
    expect(typeof body.error).toBe('string');
  });
});

// ─── The successful response ─────────────────────────────────────────────────

describe('the response a successful coverage read maps to', () => {
  it('answers 200 with one entry per date in the requested range', async () => {
    const stand = emptyStand();
    const coverage = await getCoverage(
      ADMIN,
      parseCoverageQuery(params('?mode=projected&from=2026-08-01&to=2026-08-31'), TODAY),
      { client: stand.client, evaluatedAt: AFTERNOON_AT },
    );
    const response = apiOk(coverage);

    expect(response.status).toBe(200);
    const body = (await response.json()) as typeof coverage;
    expect(body.dates).toHaveLength(31);
    expect(body.range).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    // A whole month in one request, and no date carries an unavailable marker.
    expect(body.dates.every((date) => date.unavailable === undefined)).toBe(true);
    expect(stand.tables).toHaveLength(6);
  });

  it('answers the live panel for today when the caller sends no range', async () => {
    const stand = emptyStand();
    const coverage = await getCoverage(ADMIN, parseCoverageQuery(params('?mode=live'), TODAY), {
      client: stand.client,
      evaluatedAt: AFTERNOON_AT,
    });

    expect(coverage.range).toEqual({ from: TODAY, to: TODAY });
    expect(coverage.mode).toBe('live');
    expect(coverage.liveTimeSlot).toBe('afternoon');
  });
});
