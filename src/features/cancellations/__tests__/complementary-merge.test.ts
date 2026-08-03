import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { parseCsv } from '../import/csv';
import { classifyImportFile } from '../import/classify';
import { proposeMapping, confirmMapping } from '../import/mapping';
import { buildImportPreview, identityKey, type PreviewedCaseRow } from '../import/preview';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFixture(filename: string) {
  const csvPath = join(__dirname, 'fixtures', filename);
  const text = readFileSync(csvPath, 'utf8');
  const parsed = parseCsv(text);

  const classified = classifyImportFile({
    header: parsed.header,
    dataRowCount: parsed.rows.length,
    byteSize: Buffer.byteLength(text),
  });

  if (!classified.ok) throw new Error(`Classification failed for ${filename}`);

  const draft = proposeMapping(classified.columnSet, parsed.header);
  const confirmed = confirmMapping(draft);
  if (!confirmed.confirmed) throw new Error(`Mapping blocked for ${filename}`);

  const preview = buildImportPreview({
    mapping: confirmed.mapping,
    rows: parsed.rows,
    rowNumbers: parsed.rowNumbers,
  });

  return { parsed, classified, preview, mapping: confirmed.mapping };
}

function findRow(plan: readonly PreviewedCaseRow[], policyNumber: string): PreviewedCaseRow | undefined {
  return plan.find((r) => r.fields.policy_number === policyNumber);
}

// ---------------------------------------------------------------------------
// Tests for source-aware field ownership (REQ-1.1 through REQ-1.5)
// ---------------------------------------------------------------------------

describe('complementary-merge field ownership', () => {
  const eficacia = loadFixture('eficacia_20260731.csv');
  const avisos = loadFixture('avisos_20260731_1535.csv');

  describe('eficacia-owned fields', () => {
    it('eficacia rows carry customer_name', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-001');
      expect(row).toBeDefined();
      expect(row!.fields.customer_name).toBe('Maria Garcia');
    });

    it('eficacia rows carry carrier', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-001');
      expect(row!.fields.carrier).toBe('Mapfre');
    });

    it('eficacia rows carry amount_due', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-001');
      expect(row!.fields.amount_due).toBe('1250.00');
    });

    it('eficacia rows carry producer_label', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-001');
      expect(row!.fields.producer_label).toBe('Roberto Martinez');
    });

    it('eficacia rows carry client_identifier', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-001');
      expect(row!.fields.client_identifier).toBe('CL-001');
    });

    it('eficacia rows carry legacy_send_flag', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-001');
      expect(row!.fields.legacy_send_flag).toBe('Sí');
    });

    it('eficacia rows carry legacy_state', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-001');
      expect(row!.fields.legacy_state).toBe('Pendiente');
    });

    it('eficacia rows carry case_status derived from Enviar/Estado/Resultado', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-001');
      expect(row!.fields.case_status).toBe('Imported');
    });
  });

  describe('avisos-owned fields', () => {
    it('avisos rows carry legacy_notice_label', () => {
      const row = findRow(avisos.preview.plan, 'POL-2026-001');
      expect(row).toBeDefined();
      expect(row!.fields.legacy_notice_label).toBe('Primer Aviso');
    });

    it('avisos rows carry legacy_subject', () => {
      const row = findRow(avisos.preview.plan, 'POL-2026-001');
      expect(row!.fields.legacy_subject).toBe('Aviso de Cancelacion');
    });

    it('avisos rows carry legacy_email_body', () => {
      const row = findRow(avisos.preview.plan, 'POL-2026-001');
      expect(row!.fields.legacy_email_body).toBe('Estimada Maria su poliza sera cancelada');
    });

    it('avisos rows carry legacy_sms_body', () => {
      const row = findRow(avisos.preview.plan, 'POL-2026-001');
      expect(row!.fields.legacy_sms_body).toBe('Su poliza POL-2026-001 sera cancelada');
    });

    it('avisos rows have contacts', () => {
      const row = findRow(avisos.preview.plan, 'POL-2026-001');
      expect(row!.contacts.rows.length).toBeGreaterThan(0);
    });
  });

  describe('avisos does not carry eficacia-only fields', () => {
    it('avisos rows have null amount_due (avisos has no MontoDebido column)', () => {
      const row = findRow(avisos.preview.plan, 'POL-2026-001');
      expect(row!.fields.amount_due).toBeNull();
    });

    it('avisos rows have null producer_label (avisos has no Productor column)', () => {
      const row = findRow(avisos.preview.plan, 'POL-2026-001');
      expect(row!.fields.producer_label).toBeNull();
    });

    it('avisos rows have null client_identifier', () => {
      const row = findRow(avisos.preview.plan, 'POL-2026-001');
      expect(row!.fields.client_identifier).toBeNull();
    });

    it('avisos rows have null case_status (avisos never sets status)', () => {
      const row = findRow(avisos.preview.plan, 'POL-2026-001');
      expect(row!.fields.case_status).toBeNull();
    });
  });

  describe('eficacia does not carry avisos-owned legacy fields', () => {
    it('eficacia rows have null legacy_notice_label', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-001');
      expect(row!.fields.legacy_notice_label).toBeNull();
    });

    it('eficacia rows have null legacy_subject', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-001');
      expect(row!.fields.legacy_subject).toBeNull();
    });

    it('eficacia rows have null legacy_email_body', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-001');
      expect(row!.fields.legacy_email_body).toBeNull();
    });

    it('eficacia rows have null legacy_sms_body', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-001');
      expect(row!.fields.legacy_sms_body).toBeNull();
    });
  });

  describe('eficacia then avisos order preserves both sources', () => {
    it('both files produce plans for the same case identity', () => {
      const efRow = findRow(eficacia.preview.plan, 'POL-2026-001');
      const avRow = findRow(avisos.preview.plan, 'POL-2026-001');
      expect(identityKey(efRow!.identity)).toBe(identityKey(avRow!.identity));
    });

    it('eficacia plan has no contacts for POL-2026-001', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-001');
      expect(row!.contacts.rows.length).toBe(0);
    });

    it('avisos plan has contacts for POL-2026-001', () => {
      const row = findRow(avisos.preview.plan, 'POL-2026-001');
      // maria.garcia@email.com;mgarcia@work.com → 2 emails, 3051234567 → 1 phone
      expect(row!.contacts.rows.length).toBe(3);
    });
  });

  describe('blank values will not erase populated values (REQ-1.3)', () => {
    it('avisos with null amount_due produces null in payload (RPC COALESCE preserves)', () => {
      const row = findRow(avisos.preview.plan, 'POL-2026-001');
      // avisos never carries amount_due, so it's null in the payload
      // The RPC's COALESCE(excluded.amount_due, cancellation_cases.amount_due) preserves
      expect(row!.fields.amount_due).toBeNull();
    });

    it('eficacia with null legacy_notice_label produces null (RPC preserves avisos value)', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-001');
      // eficacia never carries legacy_notice_label, so it's null
      // The RPC's case when p_column_set = 'avisos' keeps stored value
      expect(row!.fields.legacy_notice_label).toBeNull();
    });
  });

  describe('column set is correctly identified', () => {
    it('eficacia fixture is classified as eficacia', () => {
      expect(eficacia.preview.columnSet).toBe('eficacia');
    });

    it('avisos fixture is classified as avisos', () => {
      expect(avisos.preview.columnSet).toBe('avisos');
    });
  });

  describe('reimport safety', () => {
    it('reimporting eficacia produces same plan length', () => {
      const first = loadFixture('eficacia_20260731.csv');
      const second = loadFixture('eficacia_20260731.csv');
      expect(first.preview.plan.length).toBe(second.preview.plan.length);
    });

    it('reimporting avisos produces same plan length', () => {
      const first = loadFixture('avisos_20260731_1535.csv');
      const second = loadFixture('avisos_20260731_1535.csv');
      expect(first.preview.plan.length).toBe(second.preview.plan.length);
    });

    it('same file produces identical field values', () => {
      const first = loadFixture('eficacia_20260731.csv');
      const second = loadFixture('eficacia_20260731.csv');
      const row1 = findRow(first.preview.plan, 'POL-2026-010');
      const row2 = findRow(second.preview.plan, 'POL-2026-010');
      expect(row1!.fields).toEqual(row2!.fields);
    });
  });

  describe('raw row preservation (REQ-1.4)', () => {
    it('every eficacia row has a raw_row array', () => {
      for (const row of eficacia.preview.plan) {
        expect(Array.isArray(row.fields.raw_row)).toBe(true);
        expect(row.fields.raw_row.length).toBeGreaterThan(0);
      }
    });

    it('every avisos row has a raw_row array', () => {
      for (const row of avisos.preview.plan) {
        expect(Array.isArray(row.fields.raw_row)).toBe(true);
        expect(row.fields.raw_row.length).toBeGreaterThan(0);
      }
    });

    it('raw_row has same column count as the header', () => {
      const row = eficacia.preview.plan[0];
      expect(row.fields.raw_row.length).toBe(eficacia.parsed.header.length);
    });
  });

  describe('status mapping in preview (REQ-2.3)', () => {
    it('eficacia preview statusCounts sums to plan length', () => {
      const total = Object.values(eficacia.preview.statusCounts).reduce((a, b) => a + b, 0);
      expect(total).toBe(eficacia.preview.plan.length);
    });

    it('paid/recovered case has Reinstated status', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-055');
      expect(row!.fields.case_status).toBe('Reinstated');
    });

    it('cancelled/lost case has Cancelled status', () => {
      const row = findRow(eficacia.preview.plan, 'POL-2026-058');
      expect(row!.fields.case_status).toBe('Cancelled');
    });
  });
});
