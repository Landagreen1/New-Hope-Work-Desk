// Spanish import header matching, across all three importers.
//
// These tests exist because the change they cover decides which source column becomes
// `policy_number`, and a silent mis-mapping there writes the wrong policy number onto every
// imported row. Three properties are asserted rather than assumed:
//
//   1. The comparison key folds the differences that never change which column is meant, and
//      folds nothing else. `Poliza` and `PolizaNormalizada` staying distinct is as important as
//      `Póliza` and `Poliza` becoming equal.
//   2. Each alias table's cross-target overlaps are exactly the intended ones, and every
//      canonical column of every set keys distinctly, so widening a table cannot quietly send a
//      column to the wrong field.
//   3. The Spanish files the agency actually uploads map their required columns with no manager
//      intervention, and the format classifiers still tell the formats apart afterwards.

import { describe, expect, it } from 'vitest';

import {
  findHeaderPosition,
  headerMatchKey,
  headersMatch,
  matchHeaderAliases,
  overlappingAliasKeys,
} from '../header-matching';

import {
  EXPECTED_RENEWAL_ALIAS_OVERLAPS,
  RENEWAL_IMPORT_ALIASES,
} from '../../renewals/import-aliases';
import { guessMapping } from '../../renewals/api';

import { ALIASES_BY_SET } from '../../cancellations/import/aliases';
import { AVISOS_COLUMNS, EFICACIA_COLUMNS, classifyHeader } from '../../cancellations/import/classify';
import { proposeMapping, canConfirmMapping, confirmMapping } from '../../cancellations/import/mapping';

import {
  CANCELLATION_COLLECTOR_COLUMNS,
  RENEWAL_COLLECTOR_COLUMNS,
  classifyCollectorHeader,
} from '../../policy-follow-up/collector';

// ---------------------------------------------------------------------------
// The comparison key
// ---------------------------------------------------------------------------

describe('headerMatchKey', () => {
  it('folds the spellings of one Spanish column name to one key', () => {
    const key = headerMatchKey('FechaCancelacion');
    for (const spelling of [
      'FechaCancelacion',
      'fechacancelacion',
      'FECHACANCELACION',
      'Fecha Cancelacion',
      'Fecha Cancelación',
      'FECHA_CANCELACION',
      'fecha-cancelacion',
      '  Fecha  Cancelación  ',
      'Fecha de Cancelación',
      'fechaCancelacion',
      '\uFEFFFechaCancelacion',
    ]) {
      expect(headerMatchKey(spelling), spelling).toBe(key);
    }
  });

  it('keeps different words, and different word order, distinct', () => {
    const distinct = [
      'Poliza',
      'PolizaNormalizada',
      'FechaCancelacion',
      'FechaCancelacionEstimada',
      'FechaRenovacion',
      'FechaVencimiento',
      'Prima',
      'PrimaAnterior',
      'PrimaRenovacion',
      'Cliente',
      'ClienteID',
      'Estado',
      'EstadoHawkSoft',
      'Aviso',
      'AvisosEnviados',
      'PrimerAviso',
      'UltimoAviso',
    ];
    const keys = distinct.map(headerMatchKey);
    expect(new Set(keys).size).toBe(distinct.length);
  });

  it('splits CamelCase, all-caps runs, and letter/digit boundaries', () => {
    expect(headerMatchKey('MensajeSMS')).toBe(headerMatchKey('Mensaje SMS'));
    expect(headerMatchKey('SMSMessage')).toBe(headerMatchKey('SMS Message'));
    expect(headerMatchKey('ClienteID')).toBe(headerMatchKey('Cliente ID'));
    expect(headerMatchKey('EstadoHawkSoft')).toBe(headerMatchKey('Estado Hawk Soft'));
    expect(headerMatchKey('Aviso1')).toBe(headerMatchKey('Aviso 1'));
  });

  it('never returns an empty key for a name that holds a letter or digit', () => {
    expect(headerMatchKey('De')).toBe('de');
    expect(headerMatchKey('la')).toBe('la');
    expect(headerMatchKey('  ')).toBe('');
    expect(headerMatchKey(null)).toBe('');
  });

  it('refuses to match two blank names', () => {
    expect(headersMatch('', '')).toBe(false);
    expect(headersMatch('Poliza', 'Póliza')).toBe(true);
  });

  it('resolves a repeated header name to its first position', () => {
    expect(findHeaderPosition(['Cliente', 'Póliza', 'Poliza'], 'Poliza')).toBe(1);
    expect(findHeaderPosition(['Cliente'], 'Poliza')).toBeNull();
  });
});

describe('matchHeaderAliases', () => {
  const targets = [
    { target: 'policy_number', aliases: ['Poliza', 'PolizaNormalizada'] },
    { target: 'normalized', aliases: ['PolizaNormalizada'] },
  ];

  it('gives an earlier target first claim and leaves the later one what remains', () => {
    const resolved = matchHeaderAliases(['PolizaNormalizada', 'Poliza'], targets);
    expect(resolved.get('policy_number')).toBe(1);
    expect(resolved.get('normalized')).toBe(0);
  });

  it('falls back to a later alias when the preferred name is absent', () => {
    const resolved = matchHeaderAliases(['PolizaNormalizada'], targets);
    expect(resolved.get('policy_number')).toBe(0);
    expect(resolved.has('normalized')).toBe(false);
  });

  it('omits a target no alias reaches rather than guessing one', () => {
    expect(matchHeaderAliases(['Cliente'], targets).size).toBe(0);
  });

  it('honours positions a caller has reserved', () => {
    const resolved = matchHeaderAliases(['Poliza', 'PolizaNormalizada'], targets, (index) => index !== 0);
    expect(resolved.get('policy_number')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Alias table integrity
// ---------------------------------------------------------------------------

describe('alias tables', () => {
  it('overlaps only where the renewals table intends to', () => {
    expect(overlappingAliasKeys(RENEWAL_IMPORT_ALIASES)).toEqual([...EXPECTED_RENEWAL_ALIAS_OVERLAPS]);
  });

  it('never sends one name to two columns of the same cancellation set', () => {
    expect(overlappingAliasKeys(ALIASES_BY_SET.eficacia)).toEqual([]);
    expect(overlappingAliasKeys(ALIASES_BY_SET.avisos)).toEqual([]);
  });

  it('never aliases a column to the name of a different column of the same set', () => {
    for (const [set, columns] of [
      ['eficacia', EFICACIA_COLUMNS],
      ['avisos', AVISOS_COLUMNS],
    ] as const) {
      const columnKeys = new Map(columns.map((column) => [headerMatchKey(column), column]));
      for (const { target, aliases } of ALIASES_BY_SET[set]) {
        for (const alias of aliases) {
          const owner = columnKeys.get(headerMatchKey(alias));
          expect(owner ?? target, `${set}: "${alias}" aliased to ${target}`).toBe(target);
        }
      }
    }
  });

  it('keys every canonical column of every set distinctly', () => {
    for (const columns of [
      EFICACIA_COLUMNS,
      AVISOS_COLUMNS,
      RENEWAL_COLLECTOR_COLUMNS,
      CANCELLATION_COLLECTOR_COLUMNS,
    ]) {
      const keys = columns.map(headerMatchKey);
      expect(new Set(keys).size, keys.join(',')).toBe(columns.length);
    }
  });

  it('targets only fields the renewals importer knows', () => {
    const known = new Set(Object.keys(guessMapping(['Poliza', 'FechaRenovacion'])));
    expect(known.has('policy_number')).toBe(true);
    for (const { target } of RENEWAL_IMPORT_ALIASES) {
      expect(target).toMatch(/^[a-z][a-z_]*$/);
    }
  });
});

// ---------------------------------------------------------------------------
// The renewals importer, on a Spanish file
// ---------------------------------------------------------------------------

/** The 26-column consolidated Spanish renewals export, verbatim. */
const SPANISH_RENEWAL_HEADER = [
  'Compania', 'Poliza', 'PolizaNormalizada', 'Asegurado', 'LOB', 'TerminoMeses',
  'FechaRenovacion', 'FechaVencimiento', 'FechaProcesada', 'PrimaRenovacion', 'PrimaAnterior',
  'TipoRegistro', 'EstadoEnReporte', 'ClienteID', 'Titular', 'Telefonos', 'Emails',
  'EstadoHawkSoft', 'ActivaEnHawkSoft', 'PrimaHawkSoft', 'Productor', 'Cruce', 'MetodoCruce',
  'ArchivoOrigen', 'FilaOrigen', 'AvisosImportacion',
];

describe('guessMapping on a Spanish renewals export', () => {
  it('maps five of the six required columns from the file alone', () => {
    const mapping = guessMapping(SPANISH_RENEWAL_HEADER);
    expect(mapping.policy_number).toBe('Poliza');
    expect(mapping.renewal_date).toBe('FechaRenovacion');
    expect(mapping.customer_name).toBe('Asegurado');
    expect(mapping.carrier).toBe('Compania');
    expect(mapping.line_of_business).toBe('LOB');
  });

  it('maps the Spanish optional columns too', () => {
    const mapping = guessMapping(SPANISH_RENEWAL_HEADER);
    expect(mapping.customer_phone).toBe('Telefonos');
    expect(mapping.customer_email).toBe('Emails');
    expect(mapping.hawksoft_client_id).toBe('ClienteID');
    expect(mapping.premium_current).toBe('PrimaAnterior');
    expect(mapping.premium_renewal).toBe('PrimaRenovacion');
    expect(mapping.producer_name).toBe('Productor');
  });

  it('prefers the raw policy number and the renewal date over their near neighbours', () => {
    const mapping = guessMapping(SPANISH_RENEWAL_HEADER);
    expect(mapping.policy_number).not.toBe('PolizaNormalizada');
    expect(mapping.renewal_date).not.toBe('FechaVencimiento');
    expect(mapping.expiration_date).toBe('FechaVencimiento');
  });

  it('falls back to the producer for the required assignment column', () => {
    const mapping = guessMapping(SPANISH_RENEWAL_HEADER);
    expect(mapping.producer_name).toBe('Productor');
    expect(mapping.assigned_name).toBe('Productor');
  });

  it('leaves the producer alone when the file does name an assignment column', () => {
    const mapping = guessMapping([...SPANISH_RENEWAL_HEADER, 'Asignacion TXT']);
    expect(mapping.assigned_name).toBe('Asignacion TXT');
    expect(mapping.producer_name).toBe('Productor');
  });

  it('proposes no source column to two fields beyond the producer fallback', () => {
    const mapping = guessMapping(SPANISH_RENEWAL_HEADER);
    const used = Object.entries(mapping)
      .filter(([field]) => field !== 'assigned_name')
      .map(([, header]) => header);
    expect(new Set(used).size).toBe(used.length);
  });

  it('maps every required column of the Spanish export with no manager override', () => {
    const mapping = guessMapping(SPANISH_RENEWAL_HEADER);
    for (const field of [
      'customer_name', 'carrier', 'line_of_business', 'policy_number', 'renewal_date', 'assigned_name',
    ]) {
      expect(mapping[field], field).toBeTruthy();
    }
  });

  it('survives accents, spacing, and upper case in the same header', () => {
    const mapping = guessMapping([
      'COMPAÑÍA', 'Núm. de Póliza', 'Nombre del Asegurado', 'Ramo',
      'Fecha de Renovación', 'Asignación TXT', 'Teléfono', 'Correo Electrónico',
    ]);
    expect(mapping.carrier).toBe('COMPAÑÍA');
    expect(mapping.policy_number).toBe('Núm. de Póliza');
    expect(mapping.customer_name).toBe('Nombre del Asegurado');
    expect(mapping.line_of_business).toBe('Ramo');
    expect(mapping.renewal_date).toBe('Fecha de Renovación');
    expect(mapping.assigned_name).toBe('Asignación TXT');
    expect(mapping.customer_phone).toBe('Teléfono');
    expect(mapping.customer_email).toBe('Correo Electrónico');
  });

  it('still maps the older English Power BI export', () => {
    const mapping = guessMapping([
      'Named Insured', 'Company', 'LOB', 'Policy#', 'Renewal Date', 'Asignacion TXT',
      'Main Contact Phone', 'Main Contact Email', 'Client ID', 'Current Premium',
      'Renewal Premium', 'Notes', 'EFT', 'REQUOTE', 'NOTA REQUOTE',
    ]);
    expect(mapping.customer_name).toBe('Named Insured');
    expect(mapping.carrier).toBe('Company');
    expect(mapping.line_of_business).toBe('LOB');
    expect(mapping.policy_number).toBe('Policy#');
    expect(mapping.renewal_date).toBe('Renewal Date');
    expect(mapping.assigned_name).toBe('Asignacion TXT');
    expect(mapping.customer_phone).toBe('Main Contact Phone');
    expect(mapping.customer_email).toBe('Main Contact Email');
    expect(mapping.hawksoft_client_id).toBe('Client ID');
    expect(mapping.premium_current).toBe('Current Premium');
    expect(mapping.premium_renewal).toBe('Renewal Premium');
    expect(mapping.requote_note).toBe('NOTA REQUOTE');
  });
});

// ---------------------------------------------------------------------------
// The cancellations importer
// ---------------------------------------------------------------------------

describe('cancellation classification', () => {
  it('classifies an accented, spaced eficacia header', () => {
    expect(classifyHeader(['Cliente', 'Póliza', 'Compañía', 'Fecha de Cancelación'])).toBe('eficacia');
  });

  it('classifies an upper-cased, underscored eficacia header', () => {
    expect(classifyHeader(['CLIENTE', 'POLIZA', 'COMPANIA', 'FECHA_CANCELACION'])).toBe('eficacia');
  });

  it('still separates avisos from eficacia after the widening', () => {
    expect(classifyHeader([...AVISOS_COLUMNS])).toBe('avisos');
    expect(classifyHeader([...EFICACIA_COLUMNS])).toBe('eficacia');
  });

  it('still refuses a consolidated collector export on the eficacia path', () => {
    expect(classifyHeader([...CANCELLATION_COLLECTOR_COLUMNS])).toBeNull();
  });

  it('does not let an avisos file classify as eficacia through an alias', () => {
    // `Policy number` is an eficacia *alias* for `Poliza` in the mapping proposal, and must
    // stay invisible to classification: reading this file as eficacia would give it eficacia
    // field ownership in the source-aware merge.
    expect(classifyHeader(['Customer', 'Policy number', 'Carrier', 'Cancellation date'])).toBe('avisos');
  });
});

describe('proposeMapping on Spanish cancellation headers', () => {
  it('maps an accented eficacia header with no manager override', () => {
    const header = [
      'Cliente', 'Póliza', 'Compañía', 'Fecha de Cancelación', 'Monto Debido', 'Enviar',
      'Estado', 'Resultado', 'Avisos Enviados', 'Primer Aviso', 'Último Aviso', 'Productor',
      'Cliente ID',
    ];
    const draft = proposeMapping('eficacia', header);
    expect(draft.assignments.map((assignment) => assignment.column)).toEqual([...EFICACIA_COLUMNS]);
    expect(canConfirmMapping(draft)).toBe(true);
  });

  it('reaches the identity columns through aliases when the names differ', () => {
    const draft = proposeMapping('eficacia', [
      'Asegurado', 'Número de Póliza', 'Aseguradora', 'Fecha Canc', 'Monto Adeudado', 'Agente',
    ]);
    const byColumn = new Map(draft.assignments.map((a) => [a.column, a.header]));
    expect(byColumn.get('Poliza')).toBe('Número de Póliza');
    expect(byColumn.get('FechaCancelacion')).toBe('Fecha Canc');
    expect(byColumn.get('Cliente')).toBe('Asegurado');
    expect(byColumn.get('Compania')).toBe('Aseguradora');
    expect(byColumn.get('MontoDebido')).toBe('Monto Adeudado');
    expect(byColumn.get('Productor')).toBe('Agente');
    expect(canConfirmMapping(draft)).toBe(true);
  });

  it('maps a Spanish-renamed avisos header', () => {
    const draft = proposeMapping('avisos', [
      'Asegurado', 'Número de Póliza', 'Aseguradora', 'Fecha Cancelación', 'Días Restantes',
      'Tipo de Aviso', 'Correo Electrónico', 'Teléfonos', 'Asunto', 'Cuerpo Email', 'Texto SMS',
    ]);
    expect(draft.assignments.map((assignment) => assignment.column)).toEqual([...AVISOS_COLUMNS]);
    expect(canConfirmMapping(draft)).toBe(true);
  });

  it('never lets an alias take a column a header already claimed by name', () => {
    // `Cliente` names the eficacia column; `Asegurado` is only its alias, so the name wins and
    // the alias is left unmapped rather than replacing it.
    const draft = proposeMapping('eficacia', ['Asegurado', 'Cliente', 'Poliza', 'FechaCancelacion']);
    const byHeader = new Map(draft.assignments.map((a) => [a.header, a.column]));
    expect(byHeader.get('Cliente')).toBe('Cliente');
    expect(byHeader.get('Asegurado')).toBeNull();
  });

  it('proposes each source column to at most one target column', () => {
    const draft = proposeMapping('eficacia', [
      'Cliente', 'Asegurado', 'Titular', 'Poliza', 'Número de Póliza', 'FechaCancelacion',
    ]);
    const mapped = draft.assignments.map((a) => a.column).filter((column) => column !== null);
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it('leaves a column the file does not carry unmapped', () => {
    const draft = proposeMapping('eficacia', ['Poliza', 'FechaCancelacion']);
    const result = confirmMapping(draft);
    expect(result.confirmed).toBe(true);
    if (result.confirmed) {
      expect(result.mapping.columnIndex.Poliza).toBe(0);
      expect(result.mapping.columnIndex.MontoDebido).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The collector importer
// ---------------------------------------------------------------------------

describe('collector classification', () => {
  it('classifies both canonical headers', () => {
    expect(classifyCollectorHeader([...RENEWAL_COLLECTOR_COLUMNS])).toBe('renewal');
    expect(classifyCollectorHeader([...CANCELLATION_COLLECTOR_COLUMNS])).toBe('cancellation');
  });

  it('classifies a re-exported header whose words were spaced out', () => {
    const spaced = RENEWAL_COLLECTOR_COLUMNS.map((column) => column.replace(/([a-z])([A-Z])/g, '$1 $2'));
    expect(classifyCollectorHeader(spaced)).toBe('renewal');
  });

  it('classifies an accented, upper-cased cancellation header', () => {
    const shouted = ['Compañía', 'PÓLIZA', 'Poliza Normalizada', 'Asegurado', 'LOB',
      'FECHA CANCELACIÓN', 'TipoRegistro', 'Cruce'];
    expect(classifyCollectorHeader(shouted)).toBe('cancellation');
  });

  it('keeps the two collector formats apart', () => {
    expect(classifyCollectorHeader(['Poliza', 'PolizaNormalizada', 'TipoRegistro', 'Cruce'])).toBeNull();
  });
});
