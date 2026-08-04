// Cancellation import: operational outcome mapping from eficacia fields.
//
// Pure module: no React, no Supabase, no I/O, no clock. Derives the imported case
// status from the Enviar, Estado, and Resultado columns of an eficacia report.
//
// REQ-2.1: Use the efficacy fields to determine the imported case state.
// REQ-2.4: Only cases with status Imported or Open may enter reminder scheduling.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The four possible statuses an eficacia import row can resolve to.
 * - 'Imported': active pending case, eligible for automatic reminders
 * - 'Reinstated': paid/recovered, not eligible for reminders
 * - 'Cancelled': lost, not eligible for reminders
 * - 'Import Review Required': ambiguous or conflicting values, not eligible for reminders
 */
export type ImportedCaseStatus =
  | 'Imported'
  | 'Reinstated'
  | 'Cancelled'
  | 'Import Review Required';

export interface StatusMappingInput {
  /** The Enviar column raw value (legacy_send_flag). */
  enviar: string | null;
  /** The Estado column raw value (legacy_state). */
  estado: string | null;
  /** The Resultado column raw value (legacy_result). */
  resultado: string | null;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const TRUTHY_VALUES = new Set([
  'sí', 'si', 'yes', 'true', '1',
]);

const FALSY_VALUES = new Set([
  'no', 'false', '0',
]);

/**
 * Parses the Enviar field into a boolean or null.
 * - Truthy: Sí, Si, SI, TRUE, true, 1, Yes, yes
 * - Falsy: No, NO, FALSE, false, 0
 * - null/empty/unrecognized: null (ambiguous)
 */
export function parseEnviar(value: string | null | undefined): boolean | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (TRUTHY_VALUES.has(normalized)) return true;
  if (FALSY_VALUES.has(normalized)) return false;
  return null;
}

/** Estado values that indicate a pending/active case. */
const PENDING_ESTADOS = new Set(['pendiente', 'en curso']);

/** Estado value that indicates payment received. */
const PAID_ESTADO = 'pagada';

/** Estado value that indicates a cancelled policy. */
const CANCELLED_ESTADO = 'cancelada';

/**
 * Normalizes and classifies the Estado field.
 */
export function parseEstado(value: string | null | undefined): 'pending' | 'paid' | 'cancelled' | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (PENDING_ESTADOS.has(normalized)) return 'pending';
  if (normalized === PAID_ESTADO) return 'paid';
  if (normalized === CANCELLED_ESTADO) return 'cancelled';
  return null;
}

/** Resultado value that indicates recovery. */
const RECOVERED_RESULTADO = 'recuperada';

/** Resultado value that indicates a loss. */
const LOST_RESULTADO = 'perdida';

/**
 * Normalizes and classifies the Resultado field.
 */
export function parseResultado(value: string | null | undefined): 'recovered' | 'lost' | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (normalized === RECOVERED_RESULTADO) return 'recovered';
  if (normalized === LOST_RESULTADO) return 'lost';
  return null;
}

// ---------------------------------------------------------------------------
// Status derivation (REQ-2.1)
// ---------------------------------------------------------------------------

/**
 * Derives the imported case status from the three eficacia operational fields.
 *
 * Truth table:
 * | Enviar | Estado           | Resultado   | Result                  |
 * |--------|------------------|-------------|-------------------------|
 * | true   | Pendiente/curso  | —           | Imported (active)       |
 * | false  | Pagada           | Recuperada  | Reinstated              |
 * | false  | Cancelada        | Perdida     | Cancelled               |
 * | false  | unclear/other    | —           | Import Review Required  |
 * | null   | —                | —           | Import Review Required  |
 * | conflict                               | Import Review Required  |
 *
 * When all three fields are absent (null/empty), defaults to 'Imported' since the case
 * has no operational history indicating it should be excluded.
 */
export function deriveImportedStatus(input: StatusMappingInput): ImportedCaseStatus {
  const enviar = parseEnviar(input.enviar);
  const estado = parseEstado(input.estado);
  const resultado = parseResultado(input.resultado);

  // All absent: no operational data, treat as new active case
  if (enviar === null && estado === null && resultado === null) {
    return 'Imported';
  }

  // Enviar true + pending estado → active case
  if (enviar === true && (estado === 'pending' || estado === null)) {
    return 'Imported';
  }

  // Enviar false + paid + recovered → reinstated
  if (enviar === false && estado === 'paid' && resultado === 'recovered') {
    return 'Reinstated';
  }

  // Enviar false + cancelled + lost → cancelled
  if (enviar === false && estado === 'cancelled' && resultado === 'lost') {
    return 'Cancelled';
  }

  // Enviar false with unclear outcome → needs review
  if (enviar === false) {
    return 'Import Review Required';
  }

  // Enviar true but estado is paid or cancelled → conflicting, needs review
  if (enviar === true && (estado === 'paid' || estado === 'cancelled')) {
    return 'Import Review Required';
  }

  // Any other combination is ambiguous
  return 'Import Review Required';
}
