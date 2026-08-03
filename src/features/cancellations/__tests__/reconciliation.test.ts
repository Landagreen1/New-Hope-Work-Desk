import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { parseCsv } from '../import/csv';
import { classifyImportFile } from '../import/classify';
import { proposeMapping, confirmMapping } from '../import/mapping';
import { buildImportPreview } from '../import/preview';
import { reconcileImports } from '../import/reconcile';

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

  if (!classified.ok) throw new Error(`Classification failed: ${JSON.stringify(classified)}`);

  const draft = proposeMapping(classified.columnSet, parsed.header);
  const confirmed = confirmMapping(draft);
  if (!confirmed.confirmed) throw new Error(`Mapping blocked: ${JSON.stringify(confirmed.blockReasons)}`);

  const preview = buildImportPreview({
    mapping: confirmed.mapping,
    rows: parsed.rows,
    rowNumbers: parsed.rowNumbers,
  });

  return { parsed, classified, preview, mapping: confirmed.mapping };
}

// ---------------------------------------------------------------------------
// Reconciliation tests (REQ-5.2)
// ---------------------------------------------------------------------------

describe('reconcileImports with both test fixtures', () => {
  const eficacia = loadFixture('eficacia_20260731.csv');
  const avisos = loadFixture('avisos_20260731_1535.csv');
  const summary = reconcileImports(eficacia.preview, avisos.preview);

  it('reports 58 eficacia cases', () => {
    expect(summary.eficaciaCaseCount).toBe(58);
  });

  it('reports 51 avisos rows', () => {
    expect(summary.avisosRowCount).toBe(51);
  });

  it('reports 51 matching cases', () => {
    expect(summary.matchingCases).toBe(51);
  });

  it('reports 7 eficacia-only cases', () => {
    expect(summary.eficaciaOnlyCases).toBe(7);
  });

  it('reports 0 avisos-only cases', () => {
    expect(summary.avisosOnlyCases).toBe(0);
  });

  it('reports 54 active cases', () => {
    expect(summary.activeCases).toBe(54);
  });

  it('reports 3 paid/recovered cases', () => {
    expect(summary.paidRecoveredCases).toBe(3);
  });

  it('reports 1 cancelled/lost case', () => {
    expect(summary.cancelledLostCases).toBe(1);
  });

  it('reports 18 missing producer values', () => {
    expect(summary.missingProducerCount).toBe(18);
  });

  it('reports 2 deleted producer labels', () => {
    expect(summary.deletedProducerCount).toBe(2);
  });

  it('reports 6 customers with multiple policies', () => {
    expect(summary.multiPolicyCustomers).toBe(6);
  });

  it('eficacia preview shows correct status counts', () => {
    expect(eficacia.preview.statusCounts['Imported']).toBe(54);
    expect(eficacia.preview.statusCounts['Reinstated']).toBe(3);
    expect(eficacia.preview.statusCounts['Cancelled']).toBe(1);
    expect(eficacia.preview.statusCounts['Import Review Required'] ?? 0).toBe(0);
  });
});

describe('reconcileImports with eficacia only', () => {
  const eficacia = loadFixture('eficacia_20260731.csv');
  const summary = reconcileImports(eficacia.preview, null);

  it('reports zero avisos rows', () => {
    expect(summary.avisosRowCount).toBe(0);
  });

  it('reports zero matching cases', () => {
    expect(summary.matchingCases).toBe(0);
  });

  it('reports all eficacia as eficacia-only', () => {
    expect(summary.eficaciaOnlyCases).toBe(58);
  });

  it('still computes status distribution', () => {
    expect(summary.activeCases).toBe(54);
    expect(summary.paidRecoveredCases).toBe(3);
    expect(summary.cancelledLostCases).toBe(1);
  });
});

describe('reconcileImports with avisos only', () => {
  const avisos = loadFixture('avisos_20260731_1535.csv');
  const summary = reconcileImports(null, avisos.preview);

  it('reports zero eficacia cases', () => {
    expect(summary.eficaciaCaseCount).toBe(0);
  });

  it('reports all avisos as avisos-only', () => {
    expect(summary.avisosOnlyCases).toBe(51);
  });

  it('reports zero active cases (no status derivation from avisos)', () => {
    // avisos doesn't derive status, so statusCounts default to Imported
    expect(summary.activeCases).toBe(0);
  });
});
