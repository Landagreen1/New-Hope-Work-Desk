// Renewals import: the accepted source column names per target field.
//
// `guessMapping` in `./api.ts` was a table of English regular expressions. Fed the Spanish
// exports the agency actually receives — `Compania`, `Poliza`, `Asegurado`, `FechaRenovacion`,
// `Telefonos`, `Productor` — it matched exactly one of the six required columns (`LOB`), so a
// manager set the other five plus every optional column by hand on every upload.
//
// This table is the fix. Each entry is matched through `headerMatchKey`, which folds away a
// byte order mark, letter case, accents, punctuation, inner and outer whitespace, CamelCase
// versus spaced words, and the filler words `de`/`del`/`la`/`el`/`los`/`las`/`of`/`the`. One
// entry therefore covers every spelling of that name the exports produce: `Compania` covers
// `Compañía`, `COMPANIA`, and `compania`; `FechaRenovacion` covers `Fecha Renovación`,
// `Fecha de Renovacion`, and `FECHA_RENOVACION`. Listing those variants separately would be
// dead weight, so the table lists one spelling per distinct name and nothing more.
//
// Two ordering rules carry real weight, because `matchHeaderAliases` resolves by list order
// and never gives one source column to two fields:
//
//  1. **Fields are listed required-first.** A consolidated collector export carries both
//     `FechaRenovacion` and `FechaVencimiento`. `renewal_date` is listed before
//     `expiration_date`, so the required field takes the renewal date and the optional one
//     takes what is left. Reversing the two would leave the import blocked on its own data.
//
//  2. **Aliases are listed best-first.** `policy_number` lists `Poliza` ahead of
//     `PolizaNormalizada`, so a file carrying both maps the number the carrier printed, and
//     `premium_current` lists `PrimaAnterior` ahead of `PrimaHawkSoft`, so the prior-term
//     premium wins over the HawkSoft snapshot.
//
// What is deliberately *not* aliased: `customer_state` gets no Spanish entry, because `Estado`
// in these files means policy status, not a US state, and feeding a status column into the
// mailing address would corrupt every imported row. The same reasoning keeps `client_source`
// off `Origen`, which the collector uses for `ArchivoOrigen`/`FilaOrigen` provenance.
//
// Pure data module: no React, no Supabase, no I/O.

import type { HeaderAliasTarget } from '../nhwd-shared/header-matching';

/**
 * Target field to accepted source names, in resolution order.
 *
 * The target keys are `NormalizedImportRow` fields — the same keys `GUESSES` and
 * `buildNormalizedRows` use — so a mapping produced here is interchangeable with one a manager
 * sets in the mapping selects.
 */
export const RENEWAL_IMPORT_ALIASES: readonly HeaderAliasTarget[] = [
  // ── The six required columns first (RenewalManagerActions REQUIRED_FIELDS)
  {
    target: 'policy_number',
    aliases: [
      'Poliza', 'NumeroPoliza', 'NumPoliza', 'NoPoliza', 'PolizaNo', 'PolizaNumero',
      'Policy number', 'Policy', 'PolicyNo',
      'PolizaNormalizada',
    ],
  },
  {
    target: 'renewal_date',
    aliases: [
      'FechaRenovacion', 'Renovacion', 'FechaRenov',
      'Renewal date', 'Renewal',
      'FechaVencimiento', 'FechaExpiracion', 'Expiration date',
    ],
  },
  {
    target: 'customer_name',
    aliases: [
      'Asegurado', 'NombreAsegurado', 'Titular', 'NombreTitular', 'NombreCliente',
      'Nombre', 'Cliente',
      'Named insured', 'Insured', 'Customer', 'Client', 'Name',
    ],
  },
  {
    target: 'carrier',
    aliases: [
      'Compania', 'Aseguradora', 'CompaniaAseguradora', 'NombreCompania', 'Cia',
      'Carrier', 'Company', 'Writing carrier',
    ],
  },
  {
    target: 'line_of_business',
    aliases: [
      'LOB', 'LOBs', 'Ramo', 'LineaNegocio', 'TipoPoliza',
      'Line of business', 'Policy type',
    ],
  },
  {
    target: 'assigned_name',
    aliases: [
      'AsignacionTXT', 'Asignacion', 'Asignado', 'AsignadoA', 'Responsable', 'Encargado',
      'Agente', 'AgenteAsignado',
      'Assigned to', 'Assigned', 'Assignee',
    ],
  },

  // ── Optional columns (RenewalManagerActions OPTIONAL_FIELDS and the wider HawkSoft export)
  {
    target: 'customer_phone',
    aliases: [
      'Telefonos', 'Telefono', 'Tel', 'Tels', 'NumeroTelefono', 'Celular', 'Movil',
      'TelefonoCliente', 'TelefonoContacto',
      'Phone', 'Phones', 'Telephone', 'Customer phone', 'Main contact phone',
    ],
  },
  {
    target: 'customer_email',
    aliases: [
      'Emails', 'Email', 'Correo', 'Correos', 'CorreoElectronico', 'CorreoCliente',
      'Customer email', 'Main contact email', 'EmailAddress',
    ],
  },
  {
    target: 'hawksoft_client_id',
    aliases: [
      'ClienteID', 'IDCliente', 'NumeroCliente', 'NoCliente', 'CodigoCliente',
      'HawkSoftID', 'IDHawkSoft',
      'HawkSoft client id', 'Client id', 'Client no', 'Customer id', 'CMS',
    ],
  },
  {
    target: 'notice_call_date',
    aliases: [
      'AvisoCall', 'FechaAviso', 'LlamadaAviso', 'FechaLlamada', 'FechaContacto',
      'Notice call', 'Last call', 'Contact date',
    ],
  },
  {
    target: 'notes',
    aliases: [
      'Notas', 'Nota', 'Observaciones', 'Observacion', 'Comentarios', 'Comentario',
      'Notes', 'Note', 'Status note', 'Contact note',
    ],
  },
  {
    target: 'eft',
    aliases: [
      'EFT', 'PagoAutomatico', 'DebitoAutomatico', 'PagoRecurrente',
      'Electronic funds', 'Electronic funds transfer',
    ],
  },
  {
    target: 'requote',
    aliases: [
      'REQUOTE', 'Recotizar', 'Recotizacion', 'RequiereRecotizacion',
      'Requote needed', 'Requote flag',
    ],
  },
  {
    target: 'requote_note',
    aliases: [
      'NotaRequote', 'NotasRequote', 'NotaRecotizacion', 'ComentarioRequote',
      'Requote note',
    ],
  },
  {
    target: 'premium_current',
    aliases: [
      'PrimaAnterior', 'PrimaActual', 'PrimaVigente', 'PrimaPrevia', 'PrimaExpirante',
      'Current premium', 'Prior premium', 'Expiring premium', 'Old premium',
      'PrimaHawkSoft',
    ],
  },
  {
    target: 'premium_renewal',
    aliases: [
      'PrimaRenovacion', 'PrimaNueva', 'PrimaRenovada',
      'Renewal premium', 'New premium',
    ],
  },
  {
    target: 'annual_premium',
    aliases: ['PrimaAnual', 'PrimaAnualizada', 'Annual premium', 'Premium fees'],
  },
  {
    target: 'producer_name',
    aliases: ['Productor', 'AgenteProductor', 'NombreProductor', 'Producer', 'Producer name'],
  },
  {
    target: 'csr_name',
    aliases: [
      'CSR', 'NombreCSR', 'Representante', 'RepresentanteServicio', 'ServicioCliente',
      'CSR name',
    ],
  },
  {
    target: 'policy_status',
    aliases: [
      'EstadoPoliza', 'EstadoHawkSoft', 'EstadoEnReporte', 'EstadoCarrier',
      'SituacionPoliza', 'Estatus', 'Estado',
      'Policy status', 'Status',
    ],
  },
  {
    target: 'effective_date',
    aliases: [
      'FechaEfectiva', 'FechaVigencia', 'FechaInicioVigencia', 'Effective date',
    ],
  },
  {
    target: 'expiration_date',
    aliases: [
      'FechaVencimiento', 'FechaExpiracion', 'FechaTermino',
      'Expiration date', 'Exp date',
    ],
  },
  {
    target: 'inception_date',
    aliases: ['FechaInicio', 'FechaInicial', 'FechaAlta', 'Inception date'],
  },
  {
    target: 'sold_date',
    aliases: ['FechaVenta', 'Sold date'],
  },
  {
    target: 'customer_state',
    aliases: ['State', 'Mailing state'],
  },
  {
    target: 'customer_zip',
    aliases: ['CodigoPostal', 'CP', 'Zip code', 'Zip', 'Postal', 'Mailing zip'],
  },
  {
    target: 'client_since',
    aliases: ['ClienteDesde', 'FechaClienteDesde', 'Client since'],
  },
  {
    target: 'client_office',
    aliases: ['OficinaCliente', 'Oficina', 'Client office'],
  },
  {
    target: 'client_source',
    aliases: ['FuenteCliente', 'Fuente', 'ComoNosConocio', 'Client source'],
  },
  {
    target: 'application_type',
    aliases: ['TipoAplicacion', 'TipoSolicitud', 'Application type'],
  },
  {
    target: 'policy_office',
    aliases: ['OficinaPoliza', 'Policy office'],
  },
];

/**
 * The alias keys more than one target accepts, asserted by the import-header tests.
 *
 * All three are the same intentional overlap: a file that carries no `FechaRenovacion` still
 * has to produce a renewal date, and the expiration date is the only column that can supply
 * it. `renewal_date` is listed ahead of `expiration_date`, so the required field wins and the
 * optional one is left unmapped rather than both reading the same column.
 */
export const EXPECTED_RENEWAL_ALIAS_OVERLAPS: readonly string[] = [
  'expirationdate',
  'fechaexpiracion',
  'fechavencimiento',
];
