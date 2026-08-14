// Cancellation import: the accepted source column names per target column.
//
// `proposeMapping` matched a file header to a column only when the two were equal after
// `trim().toLowerCase()`. The eficacia and avisos programs emit their headers letter-perfect,
// so that held for a clean export and collapsed the moment a file arrived spelled the way
// Spanish files are actually spelled: `Póliza` with the accent, `Fecha de Cancelación` with
// spaces and a preposition, `MONTO_DEBIDO` upper-cased and underscored. Every such column fell
// to `null` and the manager re-assigned it by hand before the wizard would let them continue.
//
// Two changes fix that, and this module is the second one:
//
//   1. `classify.ts` and `mapping.ts` now compare through `headerMatchKey`, so accents, case,
//      punctuation, inner whitespace, CamelCase, and `de`/`del`/`la` between words stop
//      mattering. That alone maps every spelling of the *same* name.
//   2. This table adds the names that are genuinely different words for the same column —
//      `Aseguradora` for `Compania`, `MontoAdeudado` for `MontoDebido`, `DiasRestantes` for
//      `Days remaining` — including each set's names in the other language, since the two
//      programs have been renamed in both directions over the years.
//
// **Why this is safe, and where it deliberately stops.** These aliases are applied only inside
// `proposeMapping`, which already knows which column set the file belongs to, so `Poliza` can
// only ever resolve against the thirteen eficacia columns and `Policy number` only against the
// eleven avisos columns. They are *not* applied in `classifyHeader`, and must not be: that
// function separates the two formats by the presence of `Poliza` versus `Policy number`, and
// teaching it that those two names are equivalent would classify an avisos file as eficacia,
// which under the source-aware merge in `cancellation_import_batch` hands avisos data eficacia
// field ownership and overwrites columns avisos never carried. Classification stays on names;
// only the mapping proposal reads aliases.
//
// The alias pass also never overrides a name match. A header equal to a column name keeps that
// column, and aliases only fill the columns no header claimed by name, so adding an entry here
// cannot move a column that already maps correctly.
//
// Pure data module: no React, no Supabase, no I/O.

import type { HeaderAliasTarget } from '../../nhwd-shared/header-matching';
import type { CancellationColumn, CancellationColumnSet } from './mapping';

/**
 * eficacia aliases, in resolution order.
 *
 * `Poliza` and `FechaCancelacion` lead the list because they are the two identity columns: the
 * wizard blocks confirmation until both are mapped (Req 8.4), so they get first claim on any
 * source column two targets could accept.
 */
const EFICACIA_ALIASES: readonly HeaderAliasTarget<CancellationColumn>[] = [
  {
    target: 'Poliza',
    aliases: [
      'NumeroPoliza', 'NumPoliza', 'NoPoliza', 'PolizaNo', 'PolizaNumero',
      'Policy number', 'Policy', 'PolicyNo',
    ],
  },
  {
    target: 'FechaCancelacion',
    aliases: [
      'FechaCanc', 'FechaCancelacionEfectiva', 'Cancelacion',
      'Cancellation date', 'Cancellation effective date', 'Cancel date',
    ],
  },
  {
    target: 'Cliente',
    aliases: [
      'Asegurado', 'NombreAsegurado', 'Titular', 'NombreCliente', 'NombreTitular', 'Nombre',
      'Customer', 'Insured', 'Named insured', 'Client', 'Name',
    ],
  },
  {
    target: 'Compania',
    aliases: [
      'Aseguradora', 'CompaniaAseguradora', 'NombreCompania', 'Cia',
      'Carrier', 'Company',
    ],
  },
  {
    target: 'MontoDebido',
    aliases: [
      'MontoAdeudado', 'Monto', 'SaldoDeudor', 'Saldo', 'Deuda', 'MontoPendiente',
      'Amount due', 'Balance due', 'Balance', 'Amount owed',
    ],
  },
  {
    target: 'ClienteID',
    aliases: [
      'IDCliente', 'NumeroCliente', 'NoCliente', 'CodigoCliente', 'HawkSoftID', 'IDHawkSoft',
      'Client id', 'Customer id', 'HawkSoft client id', 'CMS',
    ],
  },
  {
    target: 'Productor',
    aliases: ['AgenteProductor', 'NombreProductor', 'Agente', 'Producer', 'Producer name'],
  },
  {
    // No `State` entry: in a HawkSoft-merged export that column is the mailing state, and
    // `Estado` here is the legacy case state.
    target: 'Estado',
    aliases: ['EstadoPoliza', 'EstadoCaso', 'Estatus', 'SituacionPoliza', 'Status'],
  },
  {
    target: 'Enviar',
    aliases: ['Envio', 'Enviado', 'DebeEnviar', 'Send', 'Send flag'],
  },
  {
    target: 'Resultado',
    aliases: ['ResultadoAviso', 'Result', 'Outcome'],
  },
  {
    target: 'AvisosEnviados',
    aliases: ['NumeroAvisos', 'CantidadAvisos', 'TotalAvisos', 'Notices sent', 'Notice count'],
  },
  {
    target: 'PrimerAviso',
    aliases: ['FechaPrimerAviso', 'Aviso1', 'First notice', 'First notice date'],
  },
  {
    target: 'UltimoAviso',
    aliases: ['FechaUltimoAviso', 'AvisoFinal', 'Last notice', 'Last notice date'],
  },
];

/**
 * avisos aliases, in resolution order. `Policy number` and `Cancellation date` lead for the
 * same identity-column reason as the eficacia list.
 */
const AVISOS_ALIASES: readonly HeaderAliasTarget<CancellationColumn>[] = [
  {
    target: 'Policy number',
    aliases: [
      'Policy', 'PolicyNo', 'Policy id',
      'Poliza', 'NumeroPoliza', 'NumPoliza', 'NoPoliza', 'PolizaNo',
    ],
  },
  {
    target: 'Cancellation date',
    aliases: [
      'Cancellation effective date', 'Cancel date', 'Cancellation',
      'FechaCancelacion', 'FechaCanc',
    ],
  },
  {
    target: 'Customer',
    aliases: [
      'Insured', 'Named insured', 'Client', 'Name',
      'Cliente', 'Asegurado', 'NombreAsegurado', 'Titular', 'NombreCliente', 'Nombre',
    ],
  },
  {
    target: 'Carrier',
    aliases: ['Company', 'Compania', 'Aseguradora', 'NombreCompania', 'Cia'],
  },
  {
    target: 'Days remaining',
    aliases: ['Days left', 'Days to cancel', 'DiasRestantes', 'Dias', 'DiasParaCancelar'],
  },
  {
    target: 'Aviso',
    aliases: ['Notice', 'Notice type', 'TipoAviso', 'NumeroAviso', 'NivelAviso'],
  },
  {
    target: 'Email',
    aliases: [
      'Emails', 'EmailAddress', 'Correo', 'Correos', 'CorreoElectronico', 'CorreoCliente',
    ],
  },
  {
    target: 'Phone',
    aliases: [
      'Phones', 'Telephone', 'Telefonos', 'Telefono', 'Tel', 'Celular', 'Movil',
      'NumeroTelefono',
    ],
  },
  {
    target: 'Asunto',
    aliases: ['Subject', 'AsuntoEmail', 'Email subject'],
  },
  {
    target: 'MensajeEmail',
    aliases: ['CuerpoEmail', 'MensajeCorreo', 'TextoEmail', 'Email message', 'Email body'],
  },
  {
    target: 'MensajeSMS',
    aliases: ['CuerpoSMS', 'MensajeTexto', 'TextoSMS', 'SMS message', 'SMS body', 'Texto'],
  },
];

/** The alias table of each column set, keyed by the classification result. */
export const ALIASES_BY_SET: Record<
  CancellationColumnSet,
  readonly HeaderAliasTarget<CancellationColumn>[]
> = {
  eficacia: EFICACIA_ALIASES,
  avisos: AVISOS_ALIASES,
};
