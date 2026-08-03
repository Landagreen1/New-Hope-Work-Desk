// src/features/cancellations/import/__tests__/import-preview.test.ts
//
// Feature: policy-follow-up-renewals-cancellations, task 9.6 — preview and re-import tests over
// `src/features/cancellations/import/preview.ts`, with the payload half of
// `src/features/cancellations/import/loader.ts` exercised against a Supabase double.
//
// **Validates: Requirements 8.5, 8.6, 8.9, 8.15, 9.2, 9.3, 9.4, 9.5, 9.7, 9.9, 9.10, 9.11, 24.5,
// 25.2**
//
// `preview.ts` is pure: it writes nothing, reads nothing, and takes the state it cannot look up
// (which case identities already exist, which contact values each case already holds) as
// parameters. Every preview case here is therefore a direct call.
//
// The one module that performs I/O is the loader, and the only I/O asserted here is the payload it
// hands to `cancellation_import_batch`. The Supabase client is a small double that answers the
// importer-profile read and records every RPC call; no live database is touched, and the assignment
// mapping is passed in so the loader performs no read for it. The escalation evaluation is turned
// off, because it is Requirement 20.10's subject and not this task's.
//
// The re-import assertion (Req 24.5) is expressed the way a pure preview can prove it: preview the
// same parsed file a second time with the identities and contact values the first import produced,
// then assert zero creates, zero new contact rows, every accepted row counted as an update, and a
// field set identical to the first import's — and that the payload the loader would send carries
// exactly that.
//
// Three decisions pinned here that a later change could reverse quietly:
//
//  1. **The lowest data row number wins a duplicate contest, whatever order the rows arrive in**
//     (Req 9.4), so a caller that sorts or streams rows differently still loads the same row.
//  2. **The four outcome counts partition the data rows.** A duplicate is neither a create nor an
//     update nor a rejection, so `rows_total` is always the sum of the four (Req 8.5).
//  3. **Notices describe only the rows that load.** A row excluded as a duplicate stores nothing,
//     so it contributes no absent-amount, unmatched-producer, or unmatched-customer entry — the
//     completion summary could never reproduce a number that counted it.

import { describe, expect, it } from 'vitest';

import { parseCsv } from '../csv';
import type { ExistingContactValues } from '../contacts';
import {
  buildImportBatchPayload,
  buildProducerAssignmentLookup,
  loadImportBatch,
  resolveProducerAssignment,
  type CancellationImportRunRow,
  type CancellationLoaderClient,
  type ImportBatchPayload,
} from '../loader';
import { EFICACIA_COLUMNS, confirmMapping, proposeMapping } from '../mapping';
import type { CancellationColumnSet, ConfirmedMapping } from '../mapping';
import {
  buildImportPreview,
  countsPartitionRowsTotal,
  previewContactRows,
  previewParsedFile,
  toImportRunCounts,
  type ImportPreview,
} from '../preview';

// ---------------------------------------------------------------------------
// Mapping and row helpers
// ---------------------------------------------------------------------------

function mappingFor(columnSet: CancellationColumnSet, header: readonly string[]): ConfirmedMapping {
  const result = confirmMapping(proposeMapping(columnSet, header));
  if (!result.confirmed) {
    throw new Error(`mapping not confirmable: ${result.blockReasons.map((r) => r.code).join(', ')}`);
  }
  return result.mapping;
}

const EFICACIA_MAPPING = mappingFor('eficacia', EFICACIA_COLUMNS);

type EficaciaColumn = (typeof EFICACIA_COLUMNS)[number];

const EFICACIA_DEFAULTS: Record<EficaciaColumn, string> = {
  Cliente: 'Ana N\u00fa\u00f1ez',
  Poliza: 'BWG63424074',
  Compania: 'Progressive',
  FechaCancelacion: '2026-07-31',
  MontoDebido: '250.75',
  Enviar: 'SI',
  Estado: 'Activo',
  Resultado: 'Pendiente',
  AvisosEnviados: '1',
  PrimerAviso: '2026-07-01',
  UltimoAviso: '2026-07-15',
  Productor: 'Maria Lopez',
  ClienteID: '007',
};

function eficaciaRow(cells: Partial<Record<EficaciaColumn, string>> = {}): string[] {
  return EFICACIA_COLUMNS.map((column) => cells[column] ?? EFICACIA_DEFAULTS[column]);
}

/** The preview of an eficacia file built from row overrides, one data row per entry. */
function previewEficacia(
  rows: readonly Partial<Record<EficaciaColumn, string>>[],
  options: { existingIdentities?: readonly { policyNumberNormalized: string; cancellationEffectiveDate: string }[] } = {},
): ImportPreview {
  return buildImportPreview({
    mapping: EFICACIA_MAPPING,
    rows: rows.map((cells) => eficaciaRow(cells)),
    existingIdentities: options.existingIdentities,
  });
}

/** Case identities grouped by their customer matching key, blank keys excluded (Req 9.10, 9.11). */
function groupsByMatchKey(preview: ImportPreview): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const entry of preview.plan) {
    const key = entry.fields.customer_match_key;
    if (key === null || key.length === 0) continue;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [entry.fields.policy_number]);
    else bucket.push(entry.fields.policy_number);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// The five counts (Req 8.5)
// ---------------------------------------------------------------------------

describe('buildImportPreview: the five counts (Req 8.5)', () => {
  const ROWS: readonly Partial<Record<EficaciaColumn, string>>[] = [
    { Poliza: 'A-1' },
    { Poliza: 'A-2' },
    // Row 3 claims the identity of row 2, so it is the duplicate.
    { Poliza: ' a-2 ' },
    // Row 4 has no policy number, so it is rejected.
    { Poliza: '  ' },
    // Row 5 carries an unparseable date, so it is rejected too.
    { Poliza: 'A-5', FechaCancelacion: 'July 31, 2026' },
  ];

  it('counts the data rows, the creates, the updates, the rejections, and the duplicates', () => {
    const preview = previewEficacia(ROWS);

    expect(preview.columnSet).toBe('eficacia');
    expect(preview.rowsTotal).toBe(5);
    expect(preview.rowsCreated).toBe(2);
    expect(preview.rowsUpdated).toBe(0);
    expect(preview.rowsRejected).toBe(2);
    expect(preview.rowsDuplicate).toBe(1);
    expect(countsPartitionRowsTotal(preview)).toBe(true);
  });

  it('renames the counts onto the import run columns', () => {
    const counts = toImportRunCounts(previewEficacia(ROWS));

    expect(counts).toMatchObject({
      rows_total: 5,
      rows_created: 2,
      rows_updated: 0,
      rows_rejected: 2,
      rows_duplicate: 1,
    });
    expect(counts.rejected_rows.map((entry) => entry.row_number)).toEqual([4, 5]);
    expect(counts.duplicate_rows).toEqual([{ row_number: 3, duplicate_of_row_number: 2 }]);
  });

  it('counts a row whose identity is already stored as an update (Req 9.2)', () => {
    const preview = previewEficacia(ROWS, {
      existingIdentities: [{ policyNumberNormalized: 'A-1', cancellationEffectiveDate: '2026-07-31' }],
    });

    expect(preview.rowsCreated).toBe(1);
    expect(preview.rowsUpdated).toBe(1);
    expect(preview.plan.map((entry) => [entry.rowNumber, entry.outcome])).toEqual([
      [1, 'update'],
      [2, 'create'],
    ]);
    expect(countsPartitionRowsTotal(preview)).toBe(true);
  });

  it('is a value: two previews of the same file are equal', () => {
    expect(previewEficacia(ROWS)).toEqual(previewEficacia(ROWS));
  });
});

// ---------------------------------------------------------------------------
// Rejections abort nothing (Req 8.6, 8.9)
// ---------------------------------------------------------------------------

describe('buildImportPreview: rejected rows are reported, not fatal (Req 8.6, 8.9)', () => {
  it('reports each rejection with its data row number and reason while every accepted row loads', () => {
    const preview = previewEficacia([
      { Poliza: 'OK-1' },
      { Poliza: '' },
      { Poliza: 'OK-3', FechaCancelacion: '2026-02-30' },
      { Poliza: 'OK-4' },
    ]);

    expect(preview.rejectedRows).toEqual([
      { row_number: 2, reason: 'policy number is empty', code: 'policy_number_empty' },
      {
        row_number: 3,
        reason: expect.stringContaining('does not name an existing calendar date'),
        code: 'cancellation_date_unparseable',
      },
    ]);
    expect(preview.plan.map((entry) => entry.rowNumber)).toEqual([1, 4]);
    expect(preview.plan.map((entry) => entry.fields.policy_number)).toEqual(['OK-1', 'OK-4']);
    expect(preview.rowsCreated).toBe(2);
  });

  it('previews a file whose every row is rejected as zero cases and zero contacts', () => {
    const preview = previewEficacia([{ Poliza: ' ' }, { Poliza: '' }]);

    expect(preview.plan).toEqual([]);
    expect(previewContactRows(preview)).toEqual([]);
    expect(preview.rowsRejected).toBe(2);
    expect(preview.rowsCreated + preview.rowsUpdated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Absent amounts and unresolved producers on the rows that load (Req 8.15, 9.7)
// ---------------------------------------------------------------------------

describe('buildImportPreview: notices of the loading rows (Req 8.15, 9.7, 9.11)', () => {
  it('records an absent amount due with its reason for each loading row', () => {
    const preview = previewEficacia([
      { Poliza: 'A-1', MontoDebido: '' },
      { Poliza: 'A-2', MontoDebido: 'nan' },
      { Poliza: 'A-3', MontoDebido: '99.99' },
    ]);

    expect(preview.amountDueAbsentRows.map((entry) => entry.row_number)).toEqual([1, 2]);
    expect(preview.amountDueAbsentRows[0].reason).toContain('amount due is empty');
    expect(preview.amountDueAbsentRows[1].reason).toContain('nan');
    expect(preview.plan.map((entry) => entry.fields.amount_due)).toEqual([null, null, '99.99']);
    expect(preview.rowsCreated).toBe(3);
  });

  it('records a (Deleted) producer label and leaves that case unassigned', () => {
    const preview = previewEficacia([
      { Poliza: 'A-1', Productor: 'Maria Lopez (Deleted)' },
      { Poliza: 'A-2', Productor: 'Maria Lopez' },
    ]);

    expect(preview.unmatchedProducerLabels).toEqual([
      { label: 'Maria Lopez (Deleted)', row_number: 1 },
    ]);
    expect(preview.plan[0].producer).toMatchObject({ deleted: true, assignedTo: null });
    expect(preview.plan[0].fields.producer_label).toBe('Maria Lopez (Deleted)');
  });

  // A duplicate row stores nothing, so a number the completion summary could never reproduce must
  // not appear in the preview.
  it('collects no notice from a row excluded as a duplicate', () => {
    const preview = previewEficacia([
      { Poliza: 'A-1', MontoDebido: '10.00', Productor: 'Maria Lopez', ClienteID: '007' },
      { Poliza: 'A-1', MontoDebido: 'nan', Productor: 'Maria Lopez (Deleted)', ClienteID: ' ', Cliente: ' ' },
    ]);

    expect(preview.rowsDuplicate).toBe(1);
    expect(preview.amountDueAbsentRows).toEqual([]);
    expect(preview.unmatchedProducerLabels).toEqual([]);
    expect(preview.unmatchedCustomerRows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// In-file duplicates (Req 9.4)
// ---------------------------------------------------------------------------

describe('buildImportPreview: two rows sharing one identity (Req 9.4)', () => {
  it('loads the lowest data row number and counts the other as a duplicate', () => {
    const preview = previewEficacia([
      { Poliza: 'BWG63424074', Compania: 'Progressive' },
      { Poliza: 'BWG63424074', Compania: 'Citizens' },
    ]);

    expect(preview.plan).toHaveLength(1);
    expect(preview.plan[0]).toMatchObject({ rowNumber: 1, outcome: 'create' });
    expect(preview.plan[0].fields.carrier).toBe('Progressive');
    expect(preview.duplicateRows).toEqual([{ row_number: 2, duplicate_of_row_number: 1 }]);
    expect(preview.rowsCreated).toBe(1);
    expect(preview.rowsDuplicate).toBe(1);
  });

  // Identity is the normalized policy number and the calendar date, so whitespace, letter case,
  // and the two accepted date formats do not create a second case.
  it('collides on the normalized policy number and the calendar date, not on the source text', () => {
    const preview = previewEficacia([
      { Poliza: 'BWG63424074', FechaCancelacion: '2026-07-31' },
      { Poliza: ' bwg 634 240 74 ', FechaCancelacion: '7/31/2026' },
    ]);

    expect(preview.rowsDuplicate).toBe(1);
    expect(preview.plan).toHaveLength(1);
    expect(preview.plan[0].identity).toEqual({
      policyNumberNormalized: 'BWG63424074',
      cancellationEffectiveDate: '2026-07-31',
    });
  });

  it('keeps the lowest data row number even when the rows arrive out of order', () => {
    const preview = buildImportPreview({
      mapping: EFICACIA_MAPPING,
      rows: [eficaciaRow({ Compania: 'Citizens' }), eficaciaRow({ Compania: 'Progressive' })],
      rowNumbers: [7, 3],
    });

    expect(preview.plan).toHaveLength(1);
    expect(preview.plan[0].rowNumber).toBe(3);
    expect(preview.plan[0].fields.carrier).toBe('Progressive');
    expect(preview.duplicateRows).toEqual([{ row_number: 7, duplicate_of_row_number: 3 }]);
  });

  it('counts every extra row carrying one identity', () => {
    const preview = previewEficacia([{}, {}, {}, {}]);

    expect(preview.rowsCreated).toBe(1);
    expect(preview.rowsDuplicate).toBe(3);
    expect(preview.duplicateRows.map((entry) => entry.row_number)).toEqual([2, 3, 4]);
    expect(countsPartitionRowsTotal(preview)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// One policy number, two effective dates (Req 9.3)
// ---------------------------------------------------------------------------

describe('buildImportPreview: the same policy number with a different effective date (Req 9.3)', () => {
  it('creates a second case rather than counting a duplicate', () => {
    const preview = previewEficacia([
      { Poliza: 'BWG63424074', FechaCancelacion: '2026-07-31' },
      { Poliza: 'BWG63424074', FechaCancelacion: '2026-08-31' },
    ]);

    expect(preview.rowsCreated).toBe(2);
    expect(preview.rowsDuplicate).toBe(0);
    expect(preview.plan.map((entry) => entry.identity.cancellationEffectiveDate)).toEqual([
      '2026-07-31',
      '2026-08-31',
    ]);
    expect(new Set(preview.plan.map((entry) => entry.key)).size).toBe(2);
  });

  it('leaves the stored case alone: the matching date updates and the new date creates', () => {
    const preview = previewEficacia(
      [
        { Poliza: 'BWG63424074', FechaCancelacion: '2026-07-31' },
        { Poliza: 'BWG63424074', FechaCancelacion: '2026-08-31' },
      ],
      {
        existingIdentities: [
          { policyNumberNormalized: 'BWG63424074', cancellationEffectiveDate: '2026-07-31' },
        ],
      },
    );

    expect(preview.plan.map((entry) => entry.outcome)).toEqual(['update', 'create']);
    expect(preview.rowsCreated).toBe(1);
    expect(preview.rowsUpdated).toBe(1);
  });

  // A stored `date` read back through a client that widens it to a timestamp still names the same
  // calendar date, so it must still match.
  it('matches a stored identity whose date arrived carrying a time component', () => {
    const preview = previewEficacia([{ Poliza: 'BWG63424074', FechaCancelacion: '2026-07-31' }], {
      existingIdentities: [],
    });

    expect(preview.rowsCreated).toBe(1);

    const withStoredRow = buildImportPreview({
      mapping: EFICACIA_MAPPING,
      rows: [eficaciaRow({ Poliza: 'BWG63424074', FechaCancelacion: '2026-07-31' })],
      existingIdentities: [
        { policy_number_normalized: 'BWG63424074', cancellation_effective_date: '2026-07-31T00:00:00+00:00' },
      ],
    });

    expect(withStoredRow.rowsUpdated).toBe(1);
    expect(withStoredRow.rowsCreated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Matched customers (Req 9.5, 9.9, 9.10, 9.11)
// ---------------------------------------------------------------------------

describe('buildImportPreview: the customer matching key (Req 9.5, 9.9, 9.10, 9.11)', () => {
  it('resolves two cases sharing a client identifier to one matched customer', () => {
    const preview = previewEficacia([
      { Poliza: 'P-1', ClienteID: '007', Cliente: 'Ana N\u00fa\u00f1ez' },
      // Same client, different policy, and a differently written name: the key is the identifier.
      { Poliza: 'P-2', ClienteID: ' 007 ', Cliente: 'ANA NUNEZ' },
      // A different identifier that a numeric conversion would have collapsed onto the first.
      { Poliza: 'P-3', ClienteID: '7', Cliente: 'Ana N\u00fa\u00f1ez' },
    ]);

    expect(preview.plan.map((entry) => entry.fields.customer_match_key)).toEqual(['007', '007', '7']);
    expect(groupsByMatchKey(preview)).toEqual(
      new Map([
        ['007', ['P-1', 'P-2']],
        ['7', ['P-3']],
      ]),
    );
    expect(preview.unmatchedCustomerRows).toEqual([]);
  });

  it('falls back to the normalized customer name where the client identifier is blank', () => {
    const preview = previewEficacia([
      { Poliza: 'P-1', ClienteID: '  ', Cliente: '  ana   n\u00fa\u00f1ez ' },
      { Poliza: 'P-2', ClienteID: '', Cliente: 'Ana N\u00fa\u00f1ez' },
    ]);

    expect(preview.plan.map((entry) => entry.fields.customer_match_key)).toEqual([
      'ANA N\u00da\u00d1EZ',
      'ANA N\u00da\u00d1EZ',
    ]);
    expect(groupsByMatchKey(preview).get('ANA N\u00da\u00d1EZ')).toEqual(['P-1', 'P-2']);
    expect(preview.plan.map((entry) => entry.fields.customer_name)).toEqual([
      '  ana   n\u00fa\u00f1ez ',
      'Ana N\u00fa\u00f1ez',
    ]);
  });

  it('loads a blank matching key with no matched customer and excludes it from grouping', () => {
    const preview = previewEficacia([
      { Poliza: 'P-1', ClienteID: '007', Cliente: 'Ana N\u00fa\u00f1ez' },
      { Poliza: 'P-2', ClienteID: '  ', Cliente: ' ' },
      { Poliza: 'P-3', ClienteID: '', Cliente: '' },
    ]);

    expect(preview.plan.map((entry) => entry.fields.customer_match_key)).toEqual(['007', null, null]);
    expect(preview.unmatchedCustomerRows).toEqual([{ row_number: 2 }, { row_number: 3 }]);
    expect(groupsByMatchKey(preview)).toEqual(new Map([['007', ['P-1']]]));
    expect(preview.rowsCreated).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The Supabase double
// ---------------------------------------------------------------------------

const MANAGER_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCER_PROFILE_ID = '22222222-2222-4222-8222-222222222222';

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

interface FakeSupabase {
  client: CancellationLoaderClient;
  rpcCalls: RpcCall[];
  tablesTouched: string[];
}

/** The one query chain the loader builds against `profiles`. */
interface ProfileQuery {
  select: () => ProfileQuery;
  eq: () => ProfileQuery;
  maybeSingle: () => Promise<{
    data: { id: string; display_name: string; role: string };
    error: null;
  }>;
}

/**
 * A Supabase double answering exactly the reads `loadImportBatch` performs when the assignment
 * mapping is supplied and the escalation evaluation is turned off: the signed-in user and its
 * profile. Every RPC call is recorded rather than executed, and the run row echoes the counts the
 * payload carried, which is what the real function returns for a batch whose upsert did what the
 * preview said it would.
 */
function fakeSupabase(role: string = 'manager'): FakeSupabase {
  const rpcCalls: RpcCall[] = [];
  const tablesTouched: string[] = [];

  const profileBuilder: ProfileQuery = {
    select: () => profileBuilder,
    eq: () => profileBuilder,
    maybeSingle: async () => ({
      data: { id: MANAGER_ID, display_name: 'Import Manager', role },
      error: null,
    }),
  };

  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: MANAGER_ID } }, error: null }),
    },
    from(table: string) {
      tablesTouched.push(table);
      return profileBuilder;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      const payload = args.p_rows as ImportBatchPayload;
      const run: CancellationImportRunRow = {
        id: `run-${rpcCalls.length}`,
        file_name: String(args.p_file_name),
        column_set: String(args.p_column_set),
        imported_by: MANAGER_ID,
        confirmed_mapping: args.p_mapping,
        rows_total: payload.counts.rows_total,
        rows_created: payload.counts.rows_created,
        rows_updated: payload.counts.rows_updated,
        rows_rejected: payload.counts.rows_rejected,
        rows_duplicate: payload.counts.rows_duplicate,
        rejected_rows: payload.counts.rejected_rows,
        duplicate_rows: payload.counts.duplicate_rows,
        unmatched_producer_labels: payload.counts.unmatched_producer_labels,
        unmatched_customer_rows: payload.counts.unmatched_customer_rows,
        invalid_contact_count: payload.counts.invalid_contact_count,
        contact_overflow_count: payload.counts.contact_overflow_count,
        amount_due_absent_rows: payload.counts.amount_due_absent_rows,
        completed_at: '2026-07-16T12:00:00.000Z',
      };
      return { data: run, error: null };
    },
  };

  return { client: client as unknown as CancellationLoaderClient, rpcCalls, tablesTouched };
}

const ASSIGNMENTS = buildProducerAssignmentLookup([
  { importLabel: 'Maria Lopez', normalizedLabel: 'MARIA LOPEZ', profileId: PRODUCER_PROFILE_ID },
]);

// ---------------------------------------------------------------------------
// The payload the loader sends (Req 9.7)
// ---------------------------------------------------------------------------

describe('buildImportBatchPayload: producer resolution (Req 9.6, 9.7)', () => {
  it('assigns a mapped label, leaves a (Deleted) label and an unmapped label unassigned', () => {
    const preview = previewEficacia([
      { Poliza: 'P-1', Productor: 'maria  lopez' },
      { Poliza: 'P-2', Productor: 'Maria Lopez (Deleted)' },
      { Poliza: 'P-3', Productor: 'Unknown Producer' },
      { Poliza: 'P-4', Productor: '   ' },
    ]);

    const built = buildImportBatchPayload(preview, ASSIGNMENTS);

    expect(built.payload.rows.map((row) => row.assigned_to)).toEqual([
      PRODUCER_PROFILE_ID,
      null,
      null,
      null,
    ]);
    expect(built.rowsAssigned).toBe(1);
    expect(built.resolutions.map((resolution) => resolution.code)).toEqual([
      'matched',
      'deleted_label',
      'no_match',
      'no_label',
    ]);
    // The (Deleted) label the preview found and the mapping miss the loader found, by row number.
    expect(built.unmatchedProducerLabels).toEqual([
      { label: 'Maria Lopez (Deleted)', row_number: 2 },
      { label: 'Unknown Producer', row_number: 3 },
    ]);
    expect(built.payload.counts.unmatched_producer_labels).toEqual(built.unmatchedProducerLabels);
  });

  it('carries only the rows that load, so a rejected and a duplicate row are absent', () => {
    const preview = previewEficacia([
      { Poliza: 'P-1' },
      { Poliza: 'P-1' },
      { Poliza: '' },
    ]);

    const built = buildImportBatchPayload(preview, ASSIGNMENTS);

    expect(built.payload.rows.map((row) => row.row_number)).toEqual([1]);
    expect(built.payload.counts.rows_rejected).toBe(1);
    expect(built.payload.counts.rows_duplicate).toBe(1);
    expect(built.payload.counts.rejected_rows).toHaveLength(1);
  });

  it('resolves a producer reading without a lookup entry to no assignment', () => {
    const resolution = resolveProducerAssignment(
      { label: 'Maria Lopez', normalizedLabel: 'MARIA LOPEZ', deleted: false, assignedTo: null, unmatchedEntry: null },
      4,
      new Map(),
    );

    expect(resolution).toEqual({
      code: 'no_match',
      assignedTo: null,
      unmatched: { label: 'Maria Lopez', row_number: 4 },
    });
  });
});

// ---------------------------------------------------------------------------
// Re-importing the byte-identical file (Req 24.5)
// ---------------------------------------------------------------------------

/**
 * One `avisos` report, written once as text so the second import is byte-identical by
 * construction. It carries, on purpose: two contact channels, a quoted `MensajeEmail` holding an
 * embedded CRLF, a row whose identity repeats an earlier row in the other accepted date format,
 * and a row with no policy number — because Requirement 24.5 holds "including where validation
 * rejects one or more rows of that second import".
 */
const AVISOS_FILE_TEXT = [
  'Customer,Policy number,Carrier,Cancellation date,Days remaining,Aviso,Email,Phone,Asunto,MensajeEmail,MensajeSMS',
  'Ana N\u00fa\u00f1ez,BWG63424074,Progressive,2026-07-31,15,Aviso 1,ANA@Example.com,(305) 555-0134,Asunto 1,"Line one\r\nLine two",SMS 1',
  'Bob Smith,BWG63424075,Citizens,7/31/2026,10,Aviso 2,bob@example.com;bob.smith@example.com,7865550199,Asunto 2,Mensaje 2,SMS 2',
  'Bob Smith,bwg 63424075,Citizens,2026-07-31,10,Aviso 2,bob@example.com,7865550199,Asunto 2,Mensaje 2,SMS 2',
  'No Policy,,Progressive,2026-08-15,5,Aviso 3,,,Asunto 4,Mensaje 4,SMS 4',
].join('\n');

/** The contact values each previewed case holds after an import of that preview. */
function contactValuesOf(preview: ImportPreview): Map<string, ExistingContactValues> {
  const values = new Map<string, ExistingContactValues>();
  for (const entry of preview.plan) {
    values.set(entry.key, {
      phone: entry.contacts.phone.rows.map((row) => row.normalized_value),
      email: entry.contacts.email.rows.map((row) => row.normalized_value),
    });
  }
  return values;
}

describe('re-importing the byte-identical file (Req 24.5)', () => {
  const parsed = parseCsv(AVISOS_FILE_TEXT);
  const mapping = mappingFor('avisos', parsed.header);

  const first = previewParsedFile(mapping, parsed);
  const second = previewParsedFile(mapping, parsed, {
    existingIdentities: first.plan.map((entry) => entry.identity),
    existingContactValues: contactValuesOf(first),
  });

  it('reads the file as three accepted rows, one duplicate, and one rejection', () => {
    expect(mapping.columnSet).toBe('avisos');
    expect(parsed.rows).toHaveLength(4);
    expect(first.rowsTotal).toBe(4);
    expect(first.rowsCreated).toBe(2);
    expect(first.rowsUpdated).toBe(0);
    expect(first.rowsDuplicate).toBe(1);
    expect(first.rowsRejected).toBe(1);
    expect(first.rejectedRows).toEqual([
      { row_number: 4, reason: 'policy number is empty', code: 'policy_number_empty' },
    ]);
    expect(first.duplicateRows).toEqual([{ row_number: 3, duplicate_of_row_number: 2 }]);
    expect(previewContactRows(first).map((row) => [row.channel, row.normalized_value])).toEqual([
      ['phone', '+13055550134'],
      ['email', 'ana@example.com'],
      ['phone', '+17865550199'],
      ['email', 'bob@example.com'],
      ['email', 'bob.smith@example.com'],
    ]);
    // The quoted value with an embedded CRLF is one field of one row, stored in its source form.
    expect(first.plan[0].fields.legacy_email_body).toBe('Line one\r\nLine two');
    expect(first.plan[0].fields.raw_row).toEqual(parsed.rows[0]);
  });

  it('creates zero additional cases and counts every accepted row as an update', () => {
    expect(second.rowsCreated).toBe(0);
    expect(second.rowsUpdated).toBe(first.rowsCreated);
    expect(second.plan.every((entry) => entry.outcome === 'update')).toBe(true);
    expect(second.rowsTotal).toBe(first.rowsTotal);
    expect(second.rowsRejected).toBe(first.rowsRejected);
    expect(second.rowsDuplicate).toBe(first.rowsDuplicate);
    expect(countsPartitionRowsTotal(second)).toBe(true);
  });

  it('creates zero additional contact rows', () => {
    expect(previewContactRows(second)).toEqual([]);
    expect(second.duplicateContactCount).toBe(previewContactRows(first).length);
    expect(second.contactOverflowCount).toBe(0);
    expect(second.invalidContactCount).toBe(0);
  });

  it('leaves every stored field value equal to its value after the first import', () => {
    expect(second.plan.map((entry) => entry.fields)).toEqual(first.plan.map((entry) => entry.fields));
    expect(second.plan.map((entry) => entry.key)).toEqual(first.plan.map((entry) => entry.key));
    expect(second.amountDueAbsentRows).toEqual(first.amountDueAbsentRows);
    expect(second.unmatchedCustomerRows).toEqual(first.unmatchedCustomerRows);
  });

  it('sends one batch per import, the second carrying no new contact rows and only updates', async () => {
    const supabase = fakeSupabase();
    const options = {
      fileName: 'avisos-2026-07-16.csv',
      mapping,
      client: supabase.client,
      assignments: ASSIGNMENTS,
      evaluateEscalations: false,
    };

    const firstLoad = await loadImportBatch({ ...options, preview: first });
    const secondLoad = await loadImportBatch({ ...options, preview: second });

    expect(firstLoad.ok).toBe(true);
    expect(secondLoad.ok).toBe(true);
    if (!firstLoad.ok || !secondLoad.ok) return;

    // One statement per import, and the only table read is the importing profile.
    expect(supabase.rpcCalls.map((call) => call.fn)).toEqual([
      'cancellation_import_batch',
      'cancellation_import_batch',
    ]);
    expect(new Set(supabase.tablesTouched)).toEqual(new Set(['profiles']));

    const firstPayload = supabase.rpcCalls[0].args.p_rows as ImportBatchPayload;
    const secondPayload = supabase.rpcCalls[1].args.p_rows as ImportBatchPayload;

    expect(supabase.rpcCalls[0].args.p_column_set).toBe('avisos');
    expect(supabase.rpcCalls[0].args.p_mapping).toBe(mapping);
    expect((supabase.rpcCalls[0].args.p_mapping as ConfirmedMapping).header).toEqual(parsed.header);

    expect(firstPayload.counts.rows_created).toBe(2);
    expect(firstPayload.rows.flatMap((row) => row.contacts)).toHaveLength(5);

    expect(secondPayload.counts.rows_created).toBe(0);
    expect(secondPayload.counts.rows_updated).toBe(2);
    expect(secondPayload.rows.flatMap((row) => row.contacts)).toEqual([]);
    expect(secondPayload.rows.map((row) => row.row_number)).toEqual(
      firstPayload.rows.map((row) => row.row_number),
    );
    // Same identities, same raw rows, same legacy values: nothing about the case changed.
    expect(secondPayload.rows.map((row) => row.raw_row)).toEqual(
      firstPayload.rows.map((row) => row.raw_row),
    );
    expect(secondLoad.outcome.rowsSent).toBe(firstLoad.outcome.rowsSent);
    expect(secondLoad.outcome.run.rows_rejected).toBe(1);
    expect(secondLoad.outcome.escalations.ran).toBe(false);
  });
});
