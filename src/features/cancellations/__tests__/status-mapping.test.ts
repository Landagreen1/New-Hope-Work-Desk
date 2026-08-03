import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  deriveImportedStatus,
  parseEnviar,
  parseEstado,
  parseResultado,
  type ImportedCaseStatus,
  type StatusMappingInput,
} from '../import/status-mapping';

// ---------------------------------------------------------------------------
// parseEnviar
// ---------------------------------------------------------------------------

describe('parseEnviar', () => {
  it.each([
    ['Sí', true],
    ['Si', true],
    ['SI', true],
    ['sí', true],
    ['si', true],
    ['TRUE', true],
    ['true', true],
    ['True', true],
    ['1', true],
    ['Yes', true],
    ['yes', true],
    ['YES', true],
  ])('returns true for truthy value %s', (value, expected) => {
    expect(parseEnviar(value)).toBe(expected);
  });

  it.each([
    ['No', false],
    ['NO', false],
    ['no', false],
    ['FALSE', false],
    ['false', false],
    ['False', false],
    ['0', false],
  ])('returns false for falsy value %s', (value, expected) => {
    expect(parseEnviar(value)).toBe(expected);
  });

  it.each([
    [null, null],
    [undefined, null],
    ['', null],
    ['  ', null],
    ['maybe', null],
    ['2', null],
    ['N/A', null],
  ])('returns null for ambiguous value %s', (value, expected) => {
    expect(parseEnviar(value as string | null | undefined)).toBe(expected);
  });

  it('trims whitespace', () => {
    expect(parseEnviar('  Sí  ')).toBe(true);
    expect(parseEnviar(' No ')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseEstado
// ---------------------------------------------------------------------------

describe('parseEstado', () => {
  it.each([
    ['Pendiente', 'pending'],
    ['pendiente', 'pending'],
    ['PENDIENTE', 'pending'],
    ['En curso', 'pending'],
    ['en curso', 'pending'],
    ['EN CURSO', 'pending'],
  ])('returns pending for %s', (value, expected) => {
    expect(parseEstado(value)).toBe(expected);
  });

  it.each([
    ['Pagada', 'paid'],
    ['pagada', 'paid'],
    ['PAGADA', 'paid'],
  ])('returns paid for %s', (value, expected) => {
    expect(parseEstado(value)).toBe(expected);
  });

  it.each([
    ['Cancelada', 'cancelled'],
    ['cancelada', 'cancelled'],
    ['CANCELADA', 'cancelled'],
  ])('returns cancelled for %s', (value, expected) => {
    expect(parseEstado(value)).toBe(expected);
  });

  it.each([
    [null, null],
    [undefined, null],
    ['', null],
    ['  ', null],
    ['Unknown', null],
    ['Active', null],
  ])('returns null for %s', (value, expected) => {
    expect(parseEstado(value as string | null | undefined)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// parseResultado
// ---------------------------------------------------------------------------

describe('parseResultado', () => {
  it.each([
    ['Recuperada', 'recovered'],
    ['recuperada', 'recovered'],
    ['RECUPERADA', 'recovered'],
  ])('returns recovered for %s', (value, expected) => {
    expect(parseResultado(value)).toBe(expected);
  });

  it.each([
    ['Perdida', 'lost'],
    ['perdida', 'lost'],
    ['PERDIDA', 'lost'],
  ])('returns lost for %s', (value, expected) => {
    expect(parseResultado(value)).toBe(expected);
  });

  it.each([
    [null, null],
    [undefined, null],
    ['', null],
    ['  ', null],
    ['Otro', null],
  ])('returns null for %s', (value, expected) => {
    expect(parseResultado(value as string | null | undefined)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// deriveImportedStatus — truth table
// ---------------------------------------------------------------------------

describe('deriveImportedStatus', () => {
  describe('active pending cases (Imported)', () => {
    it('Enviar=Sí, Estado=Pendiente → Imported', () => {
      expect(deriveImportedStatus({ enviar: 'Sí', estado: 'Pendiente', resultado: null }))
        .toBe('Imported');
    });

    it('Enviar=Si, Estado=En curso → Imported', () => {
      expect(deriveImportedStatus({ enviar: 'Si', estado: 'En curso', resultado: null }))
        .toBe('Imported');
    });

    it('Enviar=TRUE, Estado=Pendiente → Imported', () => {
      expect(deriveImportedStatus({ enviar: 'TRUE', estado: 'Pendiente', resultado: null }))
        .toBe('Imported');
    });

    it('Enviar=1, Estado=Pendiente → Imported', () => {
      expect(deriveImportedStatus({ enviar: '1', estado: 'Pendiente', resultado: null }))
        .toBe('Imported');
    });

    it('Enviar=Yes with no Estado → Imported', () => {
      expect(deriveImportedStatus({ enviar: 'Yes', estado: null, resultado: null }))
        .toBe('Imported');
    });

    it('all null → Imported (no operational data)', () => {
      expect(deriveImportedStatus({ enviar: null, estado: null, resultado: null }))
        .toBe('Imported');
    });

    it('all empty strings → Imported', () => {
      expect(deriveImportedStatus({ enviar: '', estado: '', resultado: '' }))
        .toBe('Imported');
    });
  });

  describe('paid/recovered cases (Reinstated)', () => {
    it('Enviar=No, Estado=Pagada, Resultado=Recuperada → Reinstated', () => {
      expect(deriveImportedStatus({ enviar: 'No', estado: 'Pagada', resultado: 'Recuperada' }))
        .toBe('Reinstated');
    });

    it('case-insensitive: enviar=false, estado=pagada, resultado=recuperada', () => {
      expect(deriveImportedStatus({ enviar: 'false', estado: 'pagada', resultado: 'recuperada' }))
        .toBe('Reinstated');
    });

    it('Enviar=0, Estado=Pagada, Resultado=Recuperada → Reinstated', () => {
      expect(deriveImportedStatus({ enviar: '0', estado: 'Pagada', resultado: 'Recuperada' }))
        .toBe('Reinstated');
    });
  });

  describe('cancelled/lost cases (Cancelled)', () => {
    it('Enviar=No, Estado=Cancelada, Resultado=Perdida → Cancelled', () => {
      expect(deriveImportedStatus({ enviar: 'No', estado: 'Cancelada', resultado: 'Perdida' }))
        .toBe('Cancelled');
    });

    it('case-insensitive: Enviar=FALSE, Estado=CANCELADA, Resultado=PERDIDA', () => {
      expect(deriveImportedStatus({ enviar: 'FALSE', estado: 'CANCELADA', resultado: 'PERDIDA' }))
        .toBe('Cancelled');
    });
  });

  describe('Import Review Required', () => {
    it('Enviar=No with unclear estado → Import Review Required', () => {
      expect(deriveImportedStatus({ enviar: 'No', estado: 'Unknown', resultado: null }))
        .toBe('Import Review Required');
    });

    it('Enviar=No with no estado → Import Review Required', () => {
      expect(deriveImportedStatus({ enviar: 'No', estado: null, resultado: null }))
        .toBe('Import Review Required');
    });

    it('Enviar=No, Estado=Pagada but no resultado → Import Review Required', () => {
      expect(deriveImportedStatus({ enviar: 'No', estado: 'Pagada', resultado: null }))
        .toBe('Import Review Required');
    });

    it('Enviar=No, Estado=Cancelada but resultado=Recuperada (conflict) → Import Review Required', () => {
      expect(deriveImportedStatus({ enviar: 'No', estado: 'Cancelada', resultado: 'Recuperada' }))
        .toBe('Import Review Required');
    });

    it('Enviar=Sí but Estado=Pagada (conflict) → Import Review Required', () => {
      expect(deriveImportedStatus({ enviar: 'Sí', estado: 'Pagada', resultado: 'Recuperada' }))
        .toBe('Import Review Required');
    });

    it('Enviar=Sí but Estado=Cancelada (conflict) → Import Review Required', () => {
      expect(deriveImportedStatus({ enviar: 'Sí', estado: 'Cancelada', resultado: 'Perdida' }))
        .toBe('Import Review Required');
    });

    it('unrecognized enviar value with estado present → Import Review Required', () => {
      expect(deriveImportedStatus({ enviar: 'Maybe', estado: 'Pendiente', resultado: null }))
        .toBe('Import Review Required');
    });
  });
});

// ---------------------------------------------------------------------------
// Fixture verification: eficacia_20260731.csv yields correct distribution
// ---------------------------------------------------------------------------

describe('eficacia fixture status distribution', () => {
  it('produces 54 Imported, 3 Reinstated, 1 Cancelled, 0 Import Review Required', () => {
    const csvPath = join(__dirname, 'fixtures', 'eficacia_20260731.csv');
    const text = readFileSync(csvPath, 'utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const data = lines.slice(1); // skip header

    const counts: Record<ImportedCaseStatus, number> = {
      'Imported': 0,
      'Reinstated': 0,
      'Cancelled': 0,
      'Import Review Required': 0,
    };

    for (const line of data) {
      const fields = line.split(',');
      const input: StatusMappingInput = {
        enviar: fields[5] || null,
        estado: fields[6] || null,
        resultado: fields[7] || null,
      };
      const status = deriveImportedStatus(input);
      counts[status]++;
    }

    expect(counts['Imported']).toBe(54);
    expect(counts['Reinstated']).toBe(3);
    expect(counts['Cancelled']).toBe(1);
    expect(counts['Import Review Required']).toBe(0);
  });
});
