/**
 * Spec: .kiro/specs/carrier-email-submission, Requirements 7, 9, 10.
 *
 * The whole point of this suite is the failure ordering: that a send is reserved before
 * the provider is contacted, that a duplicate key never produces a second email, and that
 * a provider failure never leaves a row claiming success.
 *
 * The Supabase client is a small in-memory fake rather than a mock library, because what
 * is being tested is the SEQUENCE of writes, and a fake that records them is easier to
 * assert against than a stack of expectations.
 */

import { describe, expect, it, vi } from 'vitest';

import { sendSubmission, type SendSubmissionInput } from '../server/send';

interface Row extends Record<string, unknown> {
  id: string;
}

/** Minimal stand-in for the parts of the client `sendSubmission` touches. */
function makeFakeClient(options?: {
  documents?: Row[];
  failInsertWith?: string;
  existingForKey?: Row | null;
}) {
  const tables: Record<string, Row[]> = {
    carrier_submissions: [],
    carrier_submission_documents: [],
    specialty_documents: (options?.documents ?? []) as Row[],
    specialty_carrier_markets: [{ id: 'cm-1', status: 'not_started' }],
    specialty_activity: [],
  };
  const writes: string[] = [];
  let idCounter = 0;

  function from(table: string) {
    const builder = {
      _filters: [] as Array<(row: Row) => boolean>,
      _selected: null as Row[] | null,
      select(_columns?: string) {
        return builder;
      },
      eq(column: string, value: unknown) {
        builder._filters.push((row) => row[column] === value);
        return builder;
      },
      in(column: string, values: unknown[]) {
        builder._filters.push((row) => values.includes(row[column]));
        return builder;
      },
      insert(payload: Row | Row[]) {
        const rows = Array.isArray(payload) ? payload : [payload];
        writes.push(`insert:${table}`);
        if (table === 'carrier_submissions' && options?.failInsertWith) {
          return {
            select: () => ({
              single: async () => ({ data: null, error: { code: options.failInsertWith } }),
            }),
          };
        }
        const stored = rows.map((row) => ({ ...row, id: `${table}-${++idCounter}` }));
        tables[table].push(...stored);
        return {
          select: () => ({ single: async () => ({ data: stored[0], error: null }) }),
          then: undefined,
          error: null,
        };
      },
      update(patch: Record<string, unknown>) {
        writes.push(`update:${table}:${patch.status ?? Object.keys(patch).join('+')}`);
        const applied = { ...builder, _patch: patch };
        const run = async () => {
          for (const row of tables[table]) {
            if (builder._filters.every((f) => f(row))) Object.assign(row, patch);
          }
          return { error: null };
        };
        return Object.assign(applied, {
          eq(column: string, value: unknown) {
            builder._filters.push((row) => row[column] === value);
            return Object.assign({}, applied, { in: () => run(), then: (r: never) => run().then(r) });
          },
          in() {
            return run();
          },
          then(resolve: (v: { error: null }) => void) {
            return run().then(resolve);
          },
        });
      },
      maybeSingle: async () => {
        if (table === 'carrier_submissions' && options?.existingForKey !== undefined) {
          return { data: options.existingForKey, error: null };
        }
        const found = tables[table].find((row) => builder._filters.every((f) => f(row)));
        return { data: found ?? null, error: null };
      },
      single: async () => {
        const found = tables[table].find((row) => builder._filters.every((f) => f(row)));
        return { data: found ?? null, error: found ? null : { code: 'PGRST116' } };
      },
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        const rows = tables[table].filter((row) => builder._filters.every((f) => f(row)));
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return builder;
  }

  return { from, tables, writes } as unknown as SendSubmissionInput['service'] & {
    tables: Record<string, Row[]>;
    writes: string[];
  };
}

function baseInput(overrides: Partial<SendSubmissionInput> = {}): SendSubmissionInput {
  const service = overrides.service ?? makeFakeClient();
  return {
    service,
    senderProfileId: 'oscar',
    opportunityId: 'opp-1',
    carrierMarketId: 'cm-1',
    marketId: 'md-1',
    connectionId: 'conn-1',
    accessToken: 'TOKEN',
    fromEmail: 'olanda@nhpfs.com',
    to: ['carrier@example.com'],
    cc: [],
    subject: 'Miru Transportation LLC - AL / PD / Cargo Submission',
    body: 'Hello,',
    documentIds: [],
    submissionKind: 'initial',
    idempotencyKey: 'key-1',
    send: vi.fn().mockResolvedValue({
      success: true, messageId: '<mid@nhpfs.com>', draftId: 'd1', failureReason: null, retryable: false,
    }),
    downloadDocument: vi.fn().mockResolvedValue(Buffer.alloc(10)),
    ...overrides,
  };
}

describe('validation happens before anything is written', () => {
  it('refuses an empty recipient list without reserving', async () => {
    const service = makeFakeClient();
    const input = baseInput({ service, to: [] });
    const result = await sendSubmission(input);
    expect(result.ok).toBe(false);
    expect((service as never as { writes: string[] }).writes).toEqual([]);
    expect(input.send).not.toHaveBeenCalled();
  });

  it('refuses a blank subject without reserving', async () => {
    const input = baseInput({ subject: '   ' });
    const result = await sendSubmission(input);
    expect(result.ok).toBe(false);
    expect(input.send).not.toHaveBeenCalled();
  });

  it('refuses a document that is not on this opportunity', async () => {
    // Scoping the lookup to the opportunity is what stops a caller attaching another
    // quote's documents by guessing an id.
    const service = makeFakeClient({ documents: [] });
    const input = baseInput({ service, documentIds: ['doc-from-another-quote'] });
    const result = await sendSubmission(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_request');
    expect(input.send).not.toHaveBeenCalled();
  });

  it('refuses when a document cannot be read from storage', async () => {
    const service = makeFakeClient({
      documents: [{ id: 'doc-1', opportunity_id: 'opp-1', file_name: 'a.pdf', storage_bucket: 'b', storage_path: 'p', mime_type: 'application/pdf', file_size: 10 }],
    });
    const input = baseInput({
      service, documentIds: ['doc-1'], downloadDocument: vi.fn().mockResolvedValue(null),
    });
    const result = await sendSubmission(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('a.pdf');
    expect(input.send).not.toHaveBeenCalled();
  });
});

describe('reserve before send', () => {
  it('inserts the row BEFORE contacting the provider', async () => {
    const service = makeFakeClient();
    const order: string[] = [];
    const send = vi.fn().mockImplementation(async () => {
      order.push('provider');
      return { success: true, messageId: '<m>', draftId: 'd', failureReason: null, retryable: false };
    });
    const input = baseInput({ service, send });
    const writes = (service as never as { writes: string[] }).writes;
    await sendSubmission(input);
    // The reservation is the first write, and it precedes the provider call.
    expect(writes[0]).toBe('insert:carrier_submissions');
    expect(order).toEqual(['provider']);
    expect(writes.indexOf('update:carrier_submissions:sent')).toBeGreaterThan(0);
  });

  it('records sent with the provider message id', async () => {
    const service = makeFakeClient();
    const result = await sendSubmission(baseInput({ service }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messageId).toBe('<mid@nhpfs.com>');
    const row = (service as never as { tables: Record<string, Row[]> }).tables.carrier_submissions[0];
    expect(row.status).toBe('sent');
    expect(row.provider_message_id).toBe('<mid@nhpfs.com>');
    expect(row.sent_at).toBeTruthy();
  });
});

describe('idempotency', () => {
  it('returns the ORIGINAL submission and sends nothing on a duplicate key', async () => {
    // The double-click. Must be indistinguishable from success to the caller, and must
    // not reach the provider.
    const service = makeFakeClient({
      failInsertWith: '23505',
      existingForKey: { id: 'sub-original', provider_message_id: '<first@nhpfs.com>', status: 'sent' },
    });
    const input = baseInput({ service });
    const result = await sendSubmission(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.duplicate).toBe(true);
    expect(result.submissionId).toBe('sub-original');
    expect(result.messageId).toBe('<first@nhpfs.com>');
    expect(input.send).not.toHaveBeenCalled();
  });

  it('reports a write failure when the key collides but the original cannot be found', async () => {
    const service = makeFakeClient({ failInsertWith: '23505', existingForKey: null });
    const input = baseInput({ service });
    const result = await sendSubmission(input);
    expect(result.ok).toBe(false);
    expect(input.send).not.toHaveBeenCalled();
  });

  it('treats a non-unique insert error as a write failure, not a duplicate', async () => {
    const service = makeFakeClient({ failInsertWith: '23514' });
    const input = baseInput({ service });
    const result = await sendSubmission(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('write_failed');
    expect(input.send).not.toHaveBeenCalled();
  });
});

describe('a failed send is never recorded as sent', () => {
  it('marks the row failed and carries the reason', async () => {
    const service = makeFakeClient();
    const send = vi.fn().mockResolvedValue({
      success: false, messageId: null, draftId: 'd1',
      failureReason: 'HTTP 403 — ErrorAccessDenied', retryable: false,
    });
    const result = await sendSubmission(baseInput({ service, send }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('provider_failed');
    expect(result.retryable).toBe(false);

    const row = (service as never as { tables: Record<string, Row[]> }).tables.carrier_submissions[0];
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toContain('ErrorAccessDenied');
    expect(row.provider_message_id).toBeUndefined();
  });

  it('writes NO attachment snapshot rows for a failed send', async () => {
    const service = makeFakeClient({
      documents: [{ id: 'doc-1', opportunity_id: 'opp-1', file_name: 'a.pdf', storage_bucket: 'b', storage_path: 'p', mime_type: 'application/pdf', file_size: 10 }],
    });
    const send = vi.fn().mockResolvedValue({
      success: false, messageId: null, draftId: null, failureReason: 'nope', retryable: true,
    });
    await sendSubmission(baseInput({ service, send, documentIds: ['doc-1'] }));
    expect((service as never as { tables: Record<string, Row[]> }).tables.carrier_submission_documents).toHaveLength(0);
  });

  it('refuses to claim success when the provider returns no message id', async () => {
    // Graph accepted it, but nothing can prove it. The database CHECK would refuse the
    // row anyway; failing here makes the reason legible instead of a constraint error.
    const service = makeFakeClient();
    const send = vi.fn().mockResolvedValue({
      success: true, messageId: null, draftId: 'd1', failureReason: null, retryable: false,
    });
    const result = await sendSubmission(baseInput({ service, send }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('returned no identifier');
    const row = (service as never as { tables: Record<string, Row[]> }).tables.carrier_submissions[0];
    expect(row.status).toBe('failed');
  });

  it('passes the provider retryable flag through to the caller', async () => {
    const send = vi.fn().mockResolvedValue({
      success: false, messageId: null, draftId: null, failureReason: 'HTTP 429', retryable: true,
    });
    const result = await sendSubmission(baseInput({ send }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(true);
  });
});

describe('attachment snapshot', () => {
  it('copies the file name and path as sent, not just a foreign key', async () => {
    const service = makeFakeClient({
      documents: [
        { id: 'doc-1', opportunity_id: 'opp-1', file_name: 'All Star Application_v1.pdf', storage_bucket: 'specialty-quote-documents', storage_path: 'opp-1/generated/cm-1/x.pdf', mime_type: 'application/pdf', file_size: 2048 },
      ],
    });
    await sendSubmission(baseInput({ service, documentIds: ['doc-1'] }));
    const snapshot = (service as never as { tables: Record<string, Row[]> }).tables.carrier_submission_documents[0];
    expect(snapshot.quote_document_id).toBe('doc-1');
    expect(snapshot.file_name).toBe('All Star Application_v1.pdf');
    expect(snapshot.storage_path).toBe('opp-1/generated/cm-1/x.pdf');
  });

  it('rejects a set of attachments over the total size cap', async () => {
    const service = makeFakeClient({
      documents: [{ id: 'doc-1', opportunity_id: 'opp-1', file_name: 'huge.pdf', storage_bucket: 'b', storage_path: 'p', mime_type: 'application/pdf', file_size: 1 }],
    });
    const input = baseInput({
      service,
      documentIds: ['doc-1'],
      downloadDocument: vi.fn().mockResolvedValue(Buffer.alloc(101 * 1024 * 1024)),
    });
    const result = await sendSubmission(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('MB');
    expect(input.send).not.toHaveBeenCalled();
  });
});
