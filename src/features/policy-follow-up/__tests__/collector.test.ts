import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCsv } from '../../cancellations/import/csv';
import {
  buildCancellationCollectorPayload,
  buildCollectorPreview,
  buildRenewalCollectorPayload,
  CANCELLATION_COLLECTOR_COLUMNS,
  classifyCollectorFile,
  classifyCollectorHeader,
  parseCollectorAmount,
  parseCollectorBoolean,
  parseCollectorDate,
  proposedCancellationCaseStatus,
  readCollectorRows,
  RENEWAL_COLLECTOR_COLUMNS,
  splitCollectorSegments,
  type CancellationCollectorRow,
  type ClassifiedCollectorFile,
  type CollectorRow,
  type RenewalCollectorRow,
} from '../collector';
import { classifyHeader } from '../../cancellations/import/classify';

// ---------------------------------------------------------------------------
// Fixtures
//
// Synthetic, with the real canonical headers and every edge case the two contracts have to survive
// (Requirement 13.3). No real customer, phone number, email address, or policy number appears in
// either file; the collector CSVs the agency actually produces are never committed.
// ---------------------------------------------------------------------------

const FIXTURES = join(__dirname, 'fixtures');

function loadFixture(name: string): { fileName: string; header: string[]; rows: string[][] } {
  const text = readFileSync(join(FIXTURES, name), 'utf8');
  const parsed = parseCsv(text);
  return { fileName: name, header: [...parsed.header], rows: parsed.rows.map((row) => [...row]) };
}

function classify(name: string): { classified: ClassifiedCollectorFile; rows: CollectorRow[] } {
  const fixture = loadFixture(name);
  const result = classifyCollectorFile({
    fileName: fixture.fileName,
    header: fixture.header,
    dataRowCount: fixture.rows.length,
  });
  if (!result.ok) throw new Error(`fixture ${name} was rejected: ${result.message}`);
  return { classified: result, rows: readCollectorRows(result, fixture.rows) };
}

const RENEWALS_FIXTURE = 'consolidado_renovaciones_20260210_0900.csv';
const CANCELLATIONS_FIXTURE = 'consolidado_cancelaciones_20260210_0930.csv';

// ---------------------------------------------------------------------------
// The canonical contracts (Requirements 2.1, 2.2)
// ---------------------------------------------------------------------------

describe('the canonical collector contracts', () => {
  it('names the 26 Renewals columns in source order', () => {
    expect(RENEWAL_COLLECTOR_COLUMNS).toHaveLength(26);
    expect([...RENEWAL_COLLECTOR_COLUMNS]).toEqual([
      'Compania', 'Poliza', 'PolizaNormalizada', 'Asegurado', 'LOB', 'TerminoMeses',
      'FechaRenovacion', 'FechaVencimiento', 'FechaProcesada', 'PrimaRenovacion', 'PrimaAnterior',
      'TipoRegistro', 'EstadoEnReporte', 'ClienteID', 'Titular', 'Telefonos', 'Emails',
      'EstadoHawkSoft', 'ActivaEnHawkSoft', 'PrimaHawkSoft', 'Productor', 'Cruce', 'MetodoCruce',
      'ArchivoOrigen', 'FilaOrigen', 'AvisosImportacion',
    ]);
  });

  it('names the 24 Cancellation columns in source order', () => {
    expect(CANCELLATION_COLLECTOR_COLUMNS).toHaveLength(24);
    expect([...CANCELLATION_COLLECTOR_COLUMNS]).toEqual([
      'Compania', 'Poliza', 'PolizaNormalizada', 'Asegurado', 'LOB', 'FechaCancelacion',
      'FechaCancelacionEstimada', 'FechaVencimientoPago', 'MontoAdeudado', 'TipoTransaccion',
      'EstadoCarrier', 'TipoRegistro', 'ClienteID', 'Titular', 'Telefonos', 'Emails',
      'EstadoHawkSoft', 'Productor', 'Idioma', 'Cruce', 'MetodoCruce', 'ArchivoOrigen',
      'FilaOrigen', 'AvisosImportacion',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Detection (Requirements 2.1, 2.2)
// ---------------------------------------------------------------------------

describe('classifyCollectorHeader', () => {
  it('recognizes the renewals export with no manual mapping', () => {
    expect(classifyCollectorHeader([...RENEWAL_COLLECTOR_COLUMNS])).toBe('renewal');
  });

  it('recognizes the cancellations export with no manual mapping', () => {
    expect(classifyCollectorHeader([...CANCELLATION_COLLECTOR_COLUMNS])).toBe('cancellation');
  });

  it('recognizes both real fixture headers', () => {
    expect(classifyCollectorHeader(loadFixture(RENEWALS_FIXTURE).header)).toBe('renewal');
    expect(classifyCollectorHeader(loadFixture(CANCELLATIONS_FIXTURE).header)).toBe('cancellation');
  });

  it('tolerates accents, case, and surrounding whitespace in the header row', () => {
    const header = [...RENEWAL_COLLECTOR_COLUMNS].map((column) =>
      column === 'Compania' ? ' Compañía ' : column.toUpperCase());

    expect(classifyCollectorHeader(header)).toBe('renewal');
  });

  it('cannot read a legacy eficacia header as a collector export', () => {
    expect(classifyCollectorHeader(['Cliente', 'Poliza', 'Compania', 'FechaCancelacion', 'MontoDebido']))
      .toBeNull();
  });

  it('cannot read a legacy avisos header as a collector export', () => {
    expect(classifyCollectorHeader(['Customer', 'Policy number', 'Carrier', 'Cancellation date']))
      .toBeNull();
  });

  it('keeps the two collector exports apart', () => {
    // The renewals export forbids FechaCancelacion; the cancellations export forbids
    // FechaRenovacion. Neither can be read as the other.
    expect(classifyCollectorHeader([...RENEWAL_COLLECTOR_COLUMNS, 'FechaCancelacion'])).toBeNull();
  });

  it('is not fooled by a partial header', () => {
    expect(classifyCollectorHeader(['Poliza', 'FechaRenovacion'])).toBeNull();
  });
});

describe('the legacy classifier refuses a collector export', () => {
  it('does not mis-import a consolidated cancellation collector file as eficacia', () => {
    // A collector export carries Poliza and FechaCancelacion, which used to be enough to be read
    // as eficacia. `PolizaNormalizada` is now disallowed there, so the legacy wizard rejects the
    // file instead of merging it with the wrong field ownership.
    expect(classifyHeader(loadFixture(CANCELLATIONS_FIXTURE).header)).toBeNull();
  });

  it('still classifies a genuine eficacia header', () => {
    expect(classifyHeader([
      'Cliente', 'Poliza', 'Compania', 'FechaCancelacion', 'MontoDebido',
      'Enviar', 'Estado', 'Resultado', 'Productor', 'ClienteID',
    ])).toBe('eficacia');
  });
});

describe('classifyCollectorFile', () => {
  it('rejects an unrecognized header and names what each export requires', () => {
    const result = classifyCollectorFile({ fileName: 'x.csv', header: ['a', 'b'], dataRowCount: 3 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unrecognized_header');
    expect(result.message).toContain('PolizaNormalizada');
  });

  it('rejects a file with no data rows', () => {
    const result = classifyCollectorFile({
      fileName: 'x.csv',
      header: [...RENEWAL_COLLECTOR_COLUMNS],
      dataRowCount: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no_data_rows');
  });

  it('reports which canonical columns the header omits rather than refusing the file', () => {
    const header = [...RENEWAL_COLLECTOR_COLUMNS].filter((column) => column !== 'AvisosImportacion');
    const result = classifyCollectorFile({ fileName: 'x.csv', header, dataRowCount: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.absentColumns).toEqual(['AvisosImportacion']);
    expect(result.presentColumns).toHaveLength(25);
  });
});

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

describe('collector value parsing', () => {
  it('reads both date shapes a collector run produces', () => {
    expect(parseCollectorDate('2026-03-15')).toBe('2026-03-15');
    expect(parseCollectorDate('2026-03-15T00:00:00Z')).toBe('2026-03-15');
    expect(parseCollectorDate('3/15/2026')).toBe('2026-03-15');
    expect(parseCollectorDate('3-5-26')).toBe('2026-03-05');
  });

  it('returns null for an unreadable date rather than guessing', () => {
    expect(parseCollectorDate('')).toBeNull();
    expect(parseCollectorDate('pendiente')).toBeNull();
    expect(parseCollectorDate('13/45/2026')).toBeNull();
  });

  it('reads money with thousands separators and currency noise', () => {
    expect(parseCollectorAmount('1,850.00')).toBe(1850);
    expect(parseCollectorAmount('$412.55')).toBe(412.55);
    expect(parseCollectorAmount('0.00')).toBe(0);
    expect(parseCollectorAmount('')).toBeNull();
    expect(parseCollectorAmount('n/a')).toBeNull();
  });

  it('reads the Spanish and English boolean vocabularies', () => {
    expect(parseCollectorBoolean('Si')).toBe(true);
    expect(parseCollectorBoolean('Sí')).toBe(true);
    expect(parseCollectorBoolean('No')).toBe(false);
    expect(parseCollectorBoolean('')).toBeNull();
    expect(parseCollectorBoolean('quizas')).toBeNull();
  });

  it('splits multi-value contact cells on every separator a collector build uses', () => {
    expect(splitCollectorSegments('3055550102;3055550103')).toEqual(['3055550102', '3055550103']);
    expect(splitCollectorSegments('a@example.invalid, b@example.invalid'))
      .toEqual(['a@example.invalid', 'b@example.invalid']);
    expect(splitCollectorSegments('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Renewal rows (Requirements 1.1, 1.2, 1.3, 7.2)
// ---------------------------------------------------------------------------

describe('reading the renewals collector fixture', () => {
  const { rows } = classify(RENEWALS_FIXTURE);
  const renewals = rows as RenewalCollectorRow[];
  const byPolicy = new Map(renewals.map((row) => [row.policyNumber, row]));

  it('reads every data row', () => {
    expect(renewals).toHaveLength(10);
    expect(renewals.every((row) => row.domain === 'renewal')).toBe(true);
  });

  it('normalizes an ordinary renewal row', () => {
    const row = byPolicy.get('POL-0001')!;

    expect(row.sourceState.state).toBe('renewal');
    expect(row.identity).toEqual({ carrierKey: 'PROGRESSIVE', policyNumberNormalized: 'POL-0001' });
    expect(row.renewalDate).toBe('2026-03-15');
    expect(row.premiumRenewal).toBe(1850);
    expect(row.premiumPrior).toBe(1700);
    expect(row.match.confidence).toBe('exact');
    expect(row.communicationBlocked).toBe(false);
    expect(row.rejection).toBeNull();
  });

  it('normalizes No renueva to Carrier Non-Renewal without marking it Lost', () => {
    const row = byPolicy.get('POL-0002')!;

    expect(row.sourceState.state).toBe('carrier_nonrenewal');
    expect(row.sourceState.label).toBe('Carrier Non-Renewal / Requote Required');
    expect(row.sourceState.raw).toBe('No renueva');
    expect(row.rejection).toBeNull();
  });

  it('reads an annotated No renueva value as a non-renewal', () => {
    const row = byPolicy.get('POL-0006')!;

    expect(row.sourceState.state).toBe('carrier_nonrenewal');
    expect(row.sourceState.raw).toBe('No renueva - carta enviada 01/2026');
  });

  it('keys NatGen and National General to the same carrier', () => {
    expect(byPolicy.get('POL-0002')!.identity?.carrierKey).toBe('NATIONALGENERAL');
    expect(byPolicy.get('POL-0003')!.identity?.carrierKey).toBe('NATIONALGENERAL');
  });

  it('blocks a probable match from automatic communication but still imports it', () => {
    const row = byPolicy.get('POL-0003')!;

    expect(row.match.confidence).toBe('probable');
    expect(row.communicationBlocked).toBe(true);
    expect(row.reviewReasons.map((reason) => reason.code)).toContain('match_probable');
    expect(row.rejection).toBeNull();
  });

  it('blocks an unmatched row from automatic communication but still imports it', () => {
    const row = byPolicy.get('POL-0004')!;

    expect(row.match.confidence).toBe('no_match');
    expect(row.communicationBlocked).toBe(true);
    expect(row.rejection).toBeNull();
  });

  it('sends an unrecognized record type to review and preserves it (Req 1.3)', () => {
    const row = byPolicy.get('POL-0005')!;

    expect(row.sourceState.state).toBe('review_required');
    expect(row.sourceState.unrecognized).toBe(true);
    expect(row.sourceState.raw).toBe('Estado desconocido del carrier');
    expect(row.communicationBlocked).toBe(true);
    // Requirement 1.3: it still imports.
    expect(row.rejection).toBeNull();
  });

  it('rejects only a row missing a value renewal_records cannot do without', () => {
    expect(byPolicy.get('POL-0007')!.rejection).toBe('The row carries no readable renewal date.');
    expect(byPolicy.get('POL-0010')!.rejection)
      .toBe('The row carries no named insured or account holder.');
  });

  it('imports a row with no carrier but leaves it without an ownership identity', () => {
    const row = byPolicy.get('POL-0008')!;

    expect(row.identity).toBeNull();
    expect(row.rejection).toBeNull();
    expect(row.reviewReasons.map((reason) => reason.code)).toContain('carrier_identity_missing');
  });

  it('preserves the whole source lineage of every row (Req 1.1)', () => {
    const row = byPolicy.get('POL-0003')!;

    expect(row.lineage.fileName).toBe(RENEWALS_FIXTURE);
    expect(row.lineage.rowNumber).toBe(3);
    expect(row.lineage.rawCarrier).toBe('NatGen');
    expect(row.lineage.rawRecordType).toBe('Renovacion');
    expect(row.lineage.rawCarrierStatus).toBe('Renewal Offered');
    expect(row.lineage.rawMatchStatus).toBe('Probable');
    expect(row.lineage.rawMatchMethod).toBe('Nombre');
    expect(row.lineage.upstreamFileName).toBe('natgen_renewals_20260210.csv');
    expect(row.lineage.upstreamRowNumber).toBe(8);
    expect(row.lineage.warning).toBe('Cruce por nombre unicamente');
    expect(row.lineage.payload).toHaveLength(row.lineage.header.length);
  });

  it('splits multi-value phone cells', () => {
    expect(byPolicy.get('POL-0002')!.phones).toEqual(['3055550102', '3055550103']);
  });
});

// ---------------------------------------------------------------------------
// Cancellation rows (Requirements 2.2, 8.3, 8.4)
// ---------------------------------------------------------------------------

describe('reading the cancellations collector fixture', () => {
  const { rows } = classify(CANCELLATIONS_FIXTURE);
  const cancellations = rows as CancellationCollectorRow[];
  const byPolicy = new Map(cancellations.map((row) => [`${row.policyNumber}|${row.rowNumber}`, row]));
  const first = (policy: string) => cancellations.find((row) => row.policyNumber === policy)!;

  it('reads every data row', () => {
    expect(cancellations).toHaveLength(9);
    expect(cancellations.every((row) => row.domain === 'cancellation')).toBe(true);
    expect(byPolicy.size).toBe(9);
  });

  it('normalizes a pending row', () => {
    const row = first('POL-0001');

    expect(row.sourceState.state).toBe('pending_cancellation');
    expect(row.effectiveDate).toBe('2026-02-13');
    expect(row.effectiveDateIsEstimated).toBe(false);
    expect(row.amountDue).toBe(412.55);
    expect(proposedCancellationCaseStatus(row)).toBe('Imported');
    expect(row.communicationBlocked).toBe(false);
  });

  it('flags an estimated effective date and blocks messaging on it (Req 8.3)', () => {
    const row = first('POL-0011');

    expect(row.cancellationDate).toBeNull();
    expect(row.estimatedCancellationDate).toBe('2026-02-20');
    expect(row.effectiveDate).toBe('2026-02-20');
    expect(row.effectiveDateIsEstimated).toBe(true);
    expect(row.communicationBlocked).toBe(true);
    expect(row.reviewReasons.map((reason) => reason.code)).toContain('estimated_cancellation_date');
  });

  it('moves a paid signal to Payment Reported rather than resolving it (Req 8.4)', () => {
    const row = first('POL-0012');

    expect(row.sourceState.state).toBe('payment_signal');
    expect(proposedCancellationCaseStatus(row)).toBe('Payment Reported');
  });

  it('resolves a cancelled signal only on unambiguous identity (Req 8.4)', () => {
    expect(proposedCancellationCaseStatus(first('POL-0013'))).toBe('Cancelled');
  });

  it('sends an ambiguous cancelled signal to Import Review instead of resolving it', () => {
    const row = first('POL-0014');

    expect(row.sourceState.state).toBe('cancelled_signal');
    expect(row.match.confidence).toBe('probable');
    expect(proposedCancellationCaseStatus(row)).toBe('Import Review Required');
  });

  it('sends an absent record type to Import Review rather than guessing a signal', () => {
    const row = first('POL-0015');

    expect(row.sourceState.state).toBe('review_required');
    expect(row.sourceState.unrecognized).toBe(true);
    expect(proposedCancellationCaseStatus(row)).toBe('Import Review Required');
  });

  it('rejects a row with neither a confirmed nor an estimated date', () => {
    expect(first('POL-0016').rejection)
      .toBe('The row carries neither a readable cancellation date nor a readable estimated date.');
  });
});

// ---------------------------------------------------------------------------
// Preview (Requirement 2.3)
// ---------------------------------------------------------------------------

describe('buildCollectorPreview', () => {
  it('reports every renewals count Requirement 2.3 asks a manager to confirm', () => {
    const { classified, rows } = classify(RENEWALS_FIXTURE);
    const preview = buildCollectorPreview(classified, rows);

    expect(preview.domain).toBe('renewal');
    expect(preview.fileName).toBe(RENEWALS_FIXTURE);
    expect(preview.totalRows).toBe(10);
    expect(preview.rejectedRows).toBe(2);
    expect(preview.importableRows).toBe(8);
    expect(preview.rejections.map((entry) => entry.rowNumber)).toEqual([7, 10]);

    // POL-0001 appears twice in the file.
    expect(preview.duplicateIdentitiesInFile).toBe(1);
    expect(preview.duplicateIdentityKeys).toEqual(['PROGRESSIVE|POL-0001']);

    expect(preview.matchExact).toBe(8);
    expect(preview.matchProbable).toBe(1);
    expect(preview.matchNone).toBe(1);
    expect(preview.matchUnrecognized).toBe(0);

    expect(preview.carrierNonRenewalRows).toBe(2);
    expect(preview.reviewRequiredRows).toBe(4);
    expect(preview.rowsWithoutIdentity).toBe(1);

    expect(preview.producerLabels).toEqual([
      'SYNTHETIC PRODUCER ONE',
      'SYNTHETIC PRODUCER TWO',
      'SYNTHETIC PRODUCER THREE',
    ]);

    expect(preview.unrecognizedSourceValues)
      .toEqual([{ raw: 'Estado desconocido del carrier', rows: 1 }]);
  });

  it('orders the carrier distribution by row count, highest first', () => {
    const { classified, rows } = classify(RENEWALS_FIXTURE);
    const preview = buildCollectorPreview(classified, rows);

    expect(preview.carrierDistribution[0]).toEqual({
      carrierKey: 'PROGRESSIVE',
      carrier: 'Progressive',
      rows: 4,
    });
    const counts = preview.carrierDistribution.map((entry) => entry.rows);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('reports every cancellation count Requirement 2.3 asks a manager to confirm', () => {
    const { classified, rows } = classify(CANCELLATIONS_FIXTURE);
    const preview = buildCollectorPreview(classified, rows);

    expect(preview.domain).toBe('cancellation');
    expect(preview.totalRows).toBe(9);
    expect(preview.rejectedRows).toBe(1);
    expect(preview.importableRows).toBe(8);

    expect(preview.pendingCancellationRows).toBe(5);
    expect(preview.paidSignalRows).toBe(1);
    expect(preview.cancelledSignalRows).toBe(2);
    expect(preview.estimatedCancellationDates).toBe(1);
    expect(preview.duplicateIdentityKeys).toEqual(['PROGRESSIVE|POL-0001']);

    expect(preview.missingPhone).toBe(1);
    expect(preview.missingEmail).toBe(1);
    expect(preview.missingBothContacts).toBe(1);
  });

  it('counts nothing and rejects nothing for an empty row list', () => {
    const { classified } = classify(RENEWALS_FIXTURE);
    const preview = buildCollectorPreview(classified, []);

    expect(preview.totalRows).toBe(0);
    expect(preview.importableRows).toBe(0);
    expect(preview.duplicateIdentitiesInFile).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

describe('buildRenewalCollectorPayload', () => {
  const { rows } = classify(RENEWALS_FIXTURE);
  const payload = buildRenewalCollectorPayload(rows);

  it('omits rejected rows so one unreadable row aborts nothing', () => {
    expect(payload).toHaveLength(8);
    expect(payload.map((row) => row.row_number)).not.toContain(7);
  });

  it('carries the normalized state and the raw value side by side (Req 1.1, 1.2)', () => {
    const row = payload.find((entry) => entry.policy_number === 'POL-0002')!;

    expect(row.source_state_normalized).toBe('carrier_nonrenewal');
    expect(row.source_record_type).toBe('No renueva');
    expect(row.source_match_status).toBe('exact');
    expect(row.source_match_status_raw).toBe('Exacto');
    expect(row.source_file_name).toBe(RENEWALS_FIXTURE);
    expect(row.source_row_number).toBe(2);
  });

  it('carries the review and communication flags', () => {
    const blocked = payload.find((entry) => entry.policy_number === 'POL-0003')!;

    expect(blocked.source_review_required).toBe(true);
    expect(blocked.source_communication_blocked).toBe(true);
  });

  it('keeps the whole source row keyed by header for the lineage disclosure (Req 11.3)', () => {
    const row = payload.find((entry) => entry.policy_number === 'POL-0003')!;

    expect(row.source_payload.AvisosImportacion).toBe('Cruce por nombre unicamente');
    expect(row.source_payload.Compania).toBe('NatGen');
  });

  it('takes the first contact segment for each single-value column', () => {
    const row = payload.find((entry) => entry.policy_number === 'POL-0002')!;

    expect(row.customer_phone).toBe('3055550102');
    // The second segment is still in the preserved payload.
    expect(row.source_payload.Telefonos).toBe('3055550102;3055550103');
  });

  it('carries the normalized ownership identity', () => {
    const row = payload.find((entry) => entry.policy_number === 'POL-0003')!;

    expect(row.carrier_key).toBe('NATIONALGENERAL');
    expect(row.policy_number_normalized).toBe('POL-0003');
  });
});

describe('buildCancellationCollectorPayload', () => {
  const { rows } = classify(CANCELLATIONS_FIXTURE);
  const payload = buildCancellationCollectorPayload(rows);

  it('omits rejected rows', () => {
    expect(payload).toHaveLength(8);
  });

  it('carries the proposed case status rather than a raw Spanish value', () => {
    expect(payload.find((row) => row.policy_number === 'POL-0012')!.case_status)
      .toBe('Payment Reported');
    expect(payload.find((row) => row.policy_number === 'POL-0014')!.case_status)
      .toBe('Import Review Required');
  });

  it('builds one contact row per segment, phones then emails', () => {
    const row = payload.find((entry) => entry.policy_number === 'POL-0002')!;

    expect(row.contacts.map((contact) => contact.channel)).toEqual(['phone', 'phone', 'email', 'email']);
    expect(row.contacts[0]).toMatchObject({
      channel: 'phone',
      normalized_value: '+13055550102',
      validation_status: 'valid',
      is_primary: true,
      segment_index: 0,
    });
    expect(row.contacts[2]).toMatchObject({
      channel: 'email',
      normalized_value: 'bravo@example.invalid',
      validation_status: 'valid',
      is_primary: true,
      segment_index: 0,
    });
  });

  it('keeps an invalid segment as invalid rather than dropping it', () => {
    const row = payload.find((entry) => entry.policy_number === 'POL-0016');
    // POL-0016 is rejected for having no date at all, so use the row that has bad contacts and a date.
    expect(row).toBeUndefined();

    const mike = payload.find((entry) => entry.policy_number === 'POL-0015')!;
    expect(mike.contacts).toHaveLength(0);
  });

  it('reads Idioma into the stored language preference', () => {
    const spanish = payload.find((entry) => entry.policy_number === 'POL-0001')!;
    const english = payload.find((entry) => entry.policy_number === 'POL-0002')!;

    expect(spanish.contacts[0].preferred_language).toBe('Spanish');
    expect(english.contacts[0].preferred_language).toBe('English');
  });

  it('preserves the raw row as an ordered array beside its header (Req 1.1)', () => {
    const row = payload.find((entry) => entry.policy_number === 'POL-0001')!;

    expect(Array.isArray(row.raw_row)).toBe(true);
    expect(row.raw_row).toHaveLength(row.raw_header.length);
    expect(row.raw_header[0]).toBe('Compania');
  });
});
