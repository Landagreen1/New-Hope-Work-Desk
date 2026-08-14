// Policy Follow-up: the source-language boundary.
//
// The desktop collector programs read carrier portals and HawkSoft and emit one canonical CSV
// per domain. Those files are Spanish and carrier-shaped: `TipoRegistro` carries `No renueva`,
// `EstadoEnReporte` carries whatever the carrier printed, `Cruce` carries `Exacto` or `Probable`.
// Agents must never have to read any of that to know what to do (Requirement 1.2).
//
// This module is the one place raw source values become stable operational concepts. It is the
// *interpretation* layer, not a replacement lifecycle: `RenewalStatus` and `CaseStatus` remain the
// domain workflow vocabularies, and `PolicySourceState` sits beside them describing what the
// source said (Requirement 1.2, design 3.2).
//
// Two rules the whole module exists to enforce:
//
//   1. **The raw value is never replaced.** Every function here takes the raw text and returns an
//      interpretation; nothing here rewrites its input. Callers persist both (Requirement 1.1).
//   2. **An unrecognized value is an exception, not a guess.** Anything this module cannot place
//      resolves to `review_required`, which imports, stays visible, and is blocked from automatic
//      customer communication until a manager reviews it (Requirement 1.3).
//
// Pure module: no React, no Supabase, no network, no file system, no clock.

// ---------------------------------------------------------------------------
// Normalized source state (Requirement 1.2)
// ---------------------------------------------------------------------------

/**
 * What the collector source said about a policy, as a stable machine value.
 *
 * Deliberately *not* a union `RenewalStatus` or `CaseStatus` has to become: a renewal record whose
 * source state is `carrier_nonrenewal` is still an open renewal in the `imported`/`assigned`/
 * `in_progress` workflow, and forcing the two vocabularies together would make every source
 * re-read look like a workflow transition (design 3.2).
 */
export type PolicySourceState =
  | 'renewal'
  | 'carrier_nonrenewal'
  | 'pending_cancellation'
  | 'payment_signal'
  | 'cancelled_signal'
  | 'review_required';

export const POLICY_SOURCE_STATES = [
  'renewal',
  'carrier_nonrenewal',
  'pending_cancellation',
  'payment_signal',
  'cancelled_signal',
  'review_required',
] as const satisfies readonly PolicySourceState[];

/**
 * The operational term an agent reads (Requirement 1.2).
 *
 * `carrier_nonrenewal` reads `Carrier Non-Renewal / Requote Required` and never `Lost`: the
 * carrier declining to offer a renewal is the moment the agency's work *starts*, so the label
 * names the required work rather than an outcome (Requirements 1.2, 7.2).
 */
export const POLICY_SOURCE_STATE_LABELS: Readonly<Record<PolicySourceState, string>> = {
  renewal: 'Renewal',
  carrier_nonrenewal: 'Carrier Non-Renewal / Requote Required',
  pending_cancellation: 'Pending Cancellation',
  payment_signal: 'Payment Reported / Verification Required',
  cancelled_signal: 'Cancelled',
  review_required: 'Review Required',
};

/** True for a source state that describes work the agency still owes the customer. */
export function isOpenSourceState(state: PolicySourceState): boolean {
  return state !== 'cancelled_signal';
}

/** True for the one source state that forces a requote ahead of ordinary renewal work (Req 7.2). */
export function isCarrierNonRenewal(state: PolicySourceState | null | undefined): boolean {
  return state === 'carrier_nonrenewal';
}

// ---------------------------------------------------------------------------
// Match confidence (Requirement 1.4)
// ---------------------------------------------------------------------------

/**
 * How reliably the collector tied a source row to a HawkSoft customer/policy.
 *
 * `unknown` is not a fourth grade of confidence — it is "the collector said something this module
 * does not recognize", and it is treated exactly as strictly as `no_match` for communication
 * safety. Keeping it distinct preserves the audit answer "what did the file actually claim".
 */
export type PolicyMatchConfidence = 'exact' | 'probable' | 'no_match' | 'unknown';

export const POLICY_MATCH_CONFIDENCE_LABELS: Readonly<Record<PolicyMatchConfidence, string>> = {
  exact: 'Exact match',
  probable: 'Probable match · review required',
  no_match: 'No match · review required',
  unknown: 'Unrecognized match result · review required',
};

/**
 * True where the match result alone is reliable enough for the normal workflow, which under
 * Requirement 1.4 is the exact/reliable grade and nothing else.
 */
export function matchPermitsAutomaticWorkflow(confidence: PolicyMatchConfidence): boolean {
  return confidence === 'exact';
}

// ---------------------------------------------------------------------------
// Text folding
// ---------------------------------------------------------------------------

const COMBINING_MARKS = /[\u0300-\u036f]/g;
const WHITESPACE_RUN = /\s+/g;
const NON_ALPHANUMERIC = /[^A-Z0-9]+/g;
const ALL_WHITESPACE = /\s/g;

/** Trimmed text, or `null` when the value is absent or holds only whitespace. */
export function trimToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The comparison key of a source value: accents removed, whitespace runs collapsed to one space,
 * case folded. `No renueva`, `NO RENUEVA`, and `No  Renueva` fold to one key, and so do
 * `Cancelación` and `Cancelacion`, because a collector run may or may not preserve the accent.
 */
export function foldSourceValue(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Source state mapping (Requirements 1.2, 1.3)
// ---------------------------------------------------------------------------

/**
 * Folded source value to normalized state.
 *
 * Both vocabularies live here on purpose: the collectors already emit machine values for the
 * cancellation domain (`pending`, `paid_signal`, `cancelled_signal` — Requirement 2.2) while the
 * renewals domain still emits Spanish report wording (`Renovación`, `No renueva` — Requirement
 * 2.1). One table means a value cannot be interpreted one way by the renewal importer and another
 * way by the cancellation importer.
 *
 * Ordering inside the table is irrelevant; lookups are exact on the folded key. A value that
 * needs prefix or substring reasoning is handled by `normalizeSourceState` below, never here.
 */
const SOURCE_STATE_BY_FOLDED_VALUE: ReadonlyMap<string, PolicySourceState> = new Map<
  string,
  PolicySourceState
>([
  // ── Renewal
  ['renovacion', 'renewal'],
  ['renovación', 'renewal'],
  ['renueva', 'renewal'],
  ['si renueva', 'renewal'],
  ['renewal', 'renewal'],
  ['renews', 'renewal'],
  ['activa', 'renewal'],
  ['active', 'renewal'],
  ['vigente', 'renewal'],
  ['renovacion automatica', 'renewal'],
  ['renewal_offer', 'renewal'],

  // ── Carrier non-renewal / requote required
  ['no renueva', 'carrier_nonrenewal'],
  ['no renovacion', 'carrier_nonrenewal'],
  ['no renovara', 'carrier_nonrenewal'],
  ['norenueva', 'carrier_nonrenewal'],
  ['no renewal', 'carrier_nonrenewal'],
  ['nonrenewal', 'carrier_nonrenewal'],
  ['non renewal', 'carrier_nonrenewal'],
  ['non-renewal', 'carrier_nonrenewal'],
  ['nonrenew', 'carrier_nonrenewal'],
  ['carrier nonrenewal', 'carrier_nonrenewal'],
  ['no renueva la poliza', 'carrier_nonrenewal'],
  ['requote', 'carrier_nonrenewal'],
  ['requote required', 'carrier_nonrenewal'],

  // ── Pending cancellation
  ['pending', 'pending_cancellation'],
  ['pendiente', 'pending_cancellation'],
  ['cancelacion pendiente', 'pending_cancellation'],
  ['pendiente de cancelacion', 'pending_cancellation'],
  ['pending cancellation', 'pending_cancellation'],
  ['en curso', 'pending_cancellation'],
  ['aviso de cancelacion', 'pending_cancellation'],
  ['pending_cancellation', 'pending_cancellation'],

  // ── Payment reported / verification required
  ['paid_signal', 'payment_signal'],
  ['paid signal', 'payment_signal'],
  ['pagada', 'payment_signal'],
  ['pagado', 'payment_signal'],
  ['pago', 'payment_signal'],
  ['pago recibido', 'payment_signal'],
  ['paid', 'payment_signal'],
  ['payment', 'payment_signal'],
  ['recuperada', 'payment_signal'],
  ['reinstated', 'payment_signal'],
  ['reinstalada', 'payment_signal'],

  // ── Cancelled
  ['cancelled_signal', 'cancelled_signal'],
  ['cancelled signal', 'cancelled_signal'],
  ['cancelada', 'cancelled_signal'],
  ['cancelado', 'cancelled_signal'],
  ['cancelacion', 'cancelled_signal'],
  ['cancelled', 'cancelled_signal'],
  ['canceled', 'cancelled_signal'],
  ['perdida', 'cancelled_signal'],
  ['lost', 'cancelled_signal'],
  ['terminada', 'cancelled_signal'],

  // ── Explicit review
  ['review_required', 'review_required'],
  ['revision requerida', 'review_required'],
  ['import review required', 'review_required'],
]);

/** One interpretation of a raw source value, carrying the raw text it was read from (Req 1.1). */
export interface NormalizedSourceState {
  /** The stable operational concept. */
  state: PolicySourceState;
  /** The operational term shown to an agent. */
  label: string;
  /** The value exactly as the collector wrote it, trimmed only, or `null` when the cell was empty. */
  raw: string | null;
  /**
   * True when the raw value named no known concept, so `state` is `review_required` because
   * nothing was recognized rather than because the source asked for a review (Requirement 1.3).
   */
  unrecognized: boolean;
}

/**
 * The normalized state of one raw source value (Requirements 1.2, 1.3).
 *
 * An empty cell and an unrecognized value both resolve to `review_required`, and both set
 * `unrecognized`, because in each case Work Desk does not know what the carrier meant. Neither
 * blocks the import: Requirement 1.3 keeps the row visible and only withholds automatic customer
 * communication.
 *
 * `fallback` is for a domain that already knows the family of its file — a renewals collector row
 * with an empty `TipoRegistro` is a renewal row, and passing `'renewal'` says so — but it is used
 * *only* when the raw value is absent. A populated value the table does not recognize is never
 * quietly replaced by the fallback.
 */
export function normalizeSourceState(
  rawValue: string | null | undefined,
  fallback?: PolicySourceState,
): NormalizedSourceState {
  const raw = trimToNull(rawValue);

  if (raw === null) {
    const state = fallback ?? 'review_required';
    return {
      state,
      label: POLICY_SOURCE_STATE_LABELS[state],
      raw: null,
      unrecognized: fallback === undefined,
    };
  }

  const folded = foldSourceValue(raw);
  const direct = SOURCE_STATE_BY_FOLDED_VALUE.get(folded);
  if (direct !== undefined) {
    return { state: direct, label: POLICY_SOURCE_STATE_LABELS[direct], raw, unrecognized: false };
  }

  // `No renueva - carta enviada 01/2026` and `NO RENUEVA (carrier)` are the same fact with an
  // annotation attached. A leading-token match is applied only for the non-renewal family, and
  // only after the exact table missed, because reading it as an ordinary renewal would silently
  // drop the requote obligation of Requirement 7.2 — the one mistake this module must not make.
  if (folded.startsWith('no renueva') || folded.startsWith('no renovacion')) {
    return {
      state: 'carrier_nonrenewal',
      label: POLICY_SOURCE_STATE_LABELS.carrier_nonrenewal,
      raw,
      unrecognized: false,
    };
  }

  return {
    state: 'review_required',
    label: POLICY_SOURCE_STATE_LABELS.review_required,
    raw,
    unrecognized: true,
  };
}

// ---------------------------------------------------------------------------
// Match confidence mapping (Requirement 1.4)
// ---------------------------------------------------------------------------

const MATCH_CONFIDENCE_BY_FOLDED_VALUE: ReadonlyMap<string, PolicyMatchConfidence> = new Map<
  string,
  PolicyMatchConfidence
>([
  ['exacto', 'exact'],
  ['exacta', 'exact'],
  ['exact', 'exact'],
  ['si', 'exact'],
  ['sí', 'exact'],
  ['yes', 'exact'],
  ['true', 'exact'],
  ['1', 'exact'],
  ['cruce exacto', 'exact'],
  ['id', 'exact'],
  ['clienteid', 'exact'],
  ['poliza', 'exact'],

  ['probable', 'probable'],
  ['parcial', 'probable'],
  ['partial', 'probable'],
  ['aproximado', 'probable'],
  ['fuzzy', 'probable'],
  ['nombre', 'probable'],
  ['revisar', 'probable'],
  ['review', 'probable'],

  ['no', 'no_match'],
  ['false', 'no_match'],
  ['0', 'no_match'],
  ['sin cruce', 'no_match'],
  ['no match', 'no_match'],
  ['nomatch', 'no_match'],
  ['ninguno', 'no_match'],
  ['no encontrado', 'no_match'],
  ['not found', 'no_match'],
]);

/** One interpretation of the collector match columns, carrying the raw values (Req 1.1, 1.4). */
export interface NormalizedMatch {
  confidence: PolicyMatchConfidence;
  label: string;
  /** `Cruce` exactly as written, trimmed, or `null`. */
  rawStatus: string | null;
  /** `MetodoCruce` exactly as written, trimmed, or `null`. */
  rawMethod: string | null;
  /** True where the workflow may proceed without manager review (Requirement 1.4). */
  permitsAutomaticWorkflow: boolean;
}

/**
 * The match confidence of one collector row (Requirement 1.4).
 *
 * `Cruce` decides the grade. `MetodoCruce` is carried for audit and is consulted only when
 * `Cruce` is empty, which is what a collector build that reports the method alone produces. An
 * empty pair is `no_match`: the safe reading of "the collector said nothing about this row" is
 * that nothing was matched, and Requirement 1.4 sends that to manager review rather than into
 * automatic communication.
 */
export function normalizeMatch(
  rawStatus: string | null | undefined,
  rawMethod?: string | null | undefined,
): NormalizedMatch {
  const status = trimToNull(rawStatus);
  const method = trimToNull(rawMethod);

  const source = status ?? method;
  let confidence: PolicyMatchConfidence;
  if (source === null) {
    confidence = 'no_match';
  } else {
    confidence = MATCH_CONFIDENCE_BY_FOLDED_VALUE.get(foldSourceValue(source)) ?? 'unknown';
  }

  return {
    confidence,
    label: POLICY_MATCH_CONFIDENCE_LABELS[confidence],
    rawStatus: status,
    rawMethod: method,
    permitsAutomaticWorkflow: matchPermitsAutomaticWorkflow(confidence),
  };
}

// ---------------------------------------------------------------------------
// Review and communication blocks (Requirements 1.3, 1.4, 12.2)
// ---------------------------------------------------------------------------

/** Why a row is held back from the normal automatic workflow. */
export type PolicyReviewReasonCode =
  | 'unrecognized_source_state'
  | 'match_probable'
  | 'match_missing'
  | 'match_unrecognized'
  | 'estimated_cancellation_date'
  | 'carrier_identity_missing';

export interface PolicyReviewReason {
  code: PolicyReviewReasonCode;
  /** One manager-facing sentence naming what must be reviewed. */
  message: string;
}

export interface PolicyReviewInput {
  state: PolicySourceState;
  /** True where the state came back `review_required` because nothing was recognized. */
  unrecognizedState: boolean;
  confidence: PolicyMatchConfidence;
  /** True where the cancellation effective date is the collector's estimate (Requirement 8.3). */
  estimatedEffectiveDate?: boolean;
  /** True where the row carries no usable carrier identity (design 4.2). */
  carrierMissing?: boolean;
}

/**
 * Every reason one row is review-required, in a fixed order so two runs over the same row produce
 * the same list (Requirements 1.3, 1.4, 8.3, 12.2).
 *
 * An empty list means the row is eligible for the ordinary workflow. A non-empty list never stops
 * the import: Requirement 1.3 keeps the row visible, and Requirement 12.2 is what withholds
 * automatic customer communication.
 */
export function policyReviewReasons(input: PolicyReviewInput): PolicyReviewReason[] {
  const reasons: PolicyReviewReason[] = [];

  if (input.unrecognizedState || input.state === 'review_required') {
    reasons.push({
      code: 'unrecognized_source_state',
      message:
        'The imported record type or carrier status is not one Work Desk recognizes. The raw value '
        + 'was preserved; a manager must confirm what it means before automatic messaging.',
    });
  }

  if (input.confidence === 'probable') {
    reasons.push({
      code: 'match_probable',
      message:
        'The collector reported a probable rather than exact customer match. Confirm the customer '
        + 'and policy before contacting them automatically.',
    });
  }

  if (input.confidence === 'no_match') {
    reasons.push({
      code: 'match_missing',
      message:
        'The collector matched this policy to no HawkSoft customer. Confirm the customer and '
        + 'policy before contacting them automatically.',
    });
  }

  if (input.confidence === 'unknown') {
    reasons.push({
      code: 'match_unrecognized',
      message:
        'The collector reported a match result Work Desk does not recognize. The raw value was '
        + 'preserved; confirm the customer before contacting them automatically.',
    });
  }

  if (input.estimatedEffectiveDate === true) {
    reasons.push({
      code: 'estimated_cancellation_date',
      message:
        'The cancellation date is the collector estimate rather than a carrier-confirmed date. '
        + 'Confirm the date before any automatic customer reminder.',
    });
  }

  if (input.carrierMissing === true) {
    reasons.push({
      code: 'carrier_identity_missing',
      message:
        'The row carries no readable carrier, so this policy cannot be tied to a shared owner by '
        + 'carrier and policy number. A manager must supply the carrier.',
    });
  }

  return reasons;
}

/**
 * True where automatic customer communication is withheld (Requirement 12.2).
 *
 * This is the *import-side* half of the rule and is deliberately conservative. It never grants
 * permission: the cancellation scheduler's own suppression, contact-validity, template, and kill
 * switch gates still run, and a false here only means this module found no reason of its own.
 */
export function communicationBlocked(input: PolicyReviewInput): boolean {
  return policyReviewReasons(input).length > 0;
}

// ---------------------------------------------------------------------------
// Policy identity (Requirement 3.1)
// ---------------------------------------------------------------------------

/**
 * Known carrier display aliases, folded, mapped to one canonical key.
 *
 * Only aliases somebody has confirmed name the same carrier belong here. Requirement 3.1 and
 * design 4.2 both forbid merging two carriers on fuzzy similarity, so there is no edit-distance
 * step anywhere in `normalizeCarrierKey`: an unlisted spelling simply keys to itself, which
 * produces a separate owner row rather than a wrong shared owner.
 */
const CARRIER_KEY_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  ['natgen', 'NATIONALGENERAL'],
  ['nationalgeneral', 'NATIONALGENERAL'],
  ['nationalgeneralinsurance', 'NATIONALGENERAL'],
  ['ngic', 'NATIONALGENERAL'],
  ['progressive', 'PROGRESSIVE'],
  ['progressiveinsurance', 'PROGRESSIVE'],
  ['progressiveamericaninsurance', 'PROGRESSIVE'],
  ['geico', 'GEICO'],
  ['statefarm', 'STATEFARM'],
  ['unitedauto', 'UNITEDAUTOMOBILE'],
  ['unitedautomobile', 'UNITEDAUTOMOBILE'],
  ['unitedautomobileinsurance', 'UNITEDAUTOMOBILE'],
  ['uaic', 'UNITEDAUTOMOBILE'],
  ['bristolwest', 'BRISTOLWEST'],
  ['infinity', 'INFINITY'],
  ['infinityinsurance', 'INFINITY'],
  ['mercury', 'MERCURY'],
  ['mercuryinsurance', 'MERCURY'],
  ['travelers', 'TRAVELERS'],
  ['thehartford', 'HARTFORD'],
  ['hartford', 'HARTFORD'],
  ['citizens', 'CITIZENS'],
  ['citizensproperty', 'CITIZENS'],
]);

/**
 * The canonical carrier key of a display value, or `null` where the value names no carrier
 * (Requirement 3.1, design 4.2).
 *
 * Accents are removed, then every character that is not a letter or digit, then the result is
 * upper-cased, and finally the confirmed alias table is consulted. `Progressive`,
 * `PROGRESSIVE INSURANCE`, and `progressive-insurance` therefore all key to `PROGRESSIVE`, while
 * `Progresive` — a typo nobody confirmed — keys to `PROGRESIVE` and owns its policies separately.
 * That is the intended failure mode: a visible duplicate a manager can correct beats a silent
 * cross-carrier ownership link.
 *
 * `null` is what design 4.2 requires a caller to treat as review-required rather than as an
 * ownership identity: without a carrier there is no `(carrier, policy)` pair to own.
 */
export function normalizeCarrierKey(carrier: string | null | undefined): string | null {
  const trimmed = trimToNull(carrier);
  if (trimmed === null) return null;

  const stripped = trimmed
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toUpperCase()
    .replace(NON_ALPHANUMERIC, '');

  if (stripped.length === 0) return null;
  return CARRIER_KEY_ALIASES.get(stripped.toLowerCase()) ?? stripped;
}

/**
 * The canonical policy number of a display value, or `null` where the value names no policy.
 *
 * This is byte-for-byte the definition `cancellation_cases.policy_number_normalized` is generated
 * with — `upper(regexp_replace(policy_number, '\s', '', 'g'))` — so a policy already stored as a
 * cancellation case keys to the same owner row the renewals side computes for it. Leading zeros,
 * hyphens, and every other non-whitespace character survive, because two carriers do use policy
 * numbers that differ only by a hyphen.
 */
export function normalizePolicyNumber(policyNumber: string | null | undefined): string | null {
  const trimmed = (policyNumber ?? '').replace(ALL_WHITESPACE, '').toUpperCase();
  return trimmed.length === 0 ? null : trimmed;
}

/** The shared ownership identity of Requirement 3.1: normalized carrier key plus policy number. */
export interface PolicyIdentity {
  carrierKey: string;
  policyNumberNormalized: string;
}

/**
 * The shared ownership identity of one row, or `null` where either half is missing
 * (Requirement 3.1).
 *
 * Customer name is deliberately not part of it. Requirement 3.1 says so, and the reason is
 * operational: the same policy is spelled three ways across a carrier portal, HawkSoft, and a
 * renewal report, so a name-derived identity would split one policy's ownership across imports.
 */
export function policyIdentity(
  carrier: string | null | undefined,
  policyNumber: string | null | undefined,
): PolicyIdentity | null {
  const carrierKey = normalizeCarrierKey(carrier);
  const policyNumberNormalized = normalizePolicyNumber(policyNumber);
  if (carrierKey === null || policyNumberNormalized === null) return null;
  return { carrierKey, policyNumberNormalized };
}

/** Stable text form of an identity, for a map key or a log line. */
export function policyIdentityKey(identity: PolicyIdentity): string {
  return `${identity.carrierKey}|${identity.policyNumberNormalized}`;
}

// ---------------------------------------------------------------------------
// Assignment source (Requirement 13.2)
// ---------------------------------------------------------------------------

/**
 * Where a policy's ownership came from. Every value is attributable to an actor or a rule, which
 * is the whole of Requirement 13.2.
 */
export type PolicyAssignmentSource =
  | 'migration'
  | 'existing_owner'
  | 'producer_mapping'
  | 'weighted_auto'
  | 'manager';

export const POLICY_ASSIGNMENT_SOURCE_LABELS: Readonly<Record<PolicyAssignmentSource, string>> = {
  migration: 'Bootstrapped from the existing domain assignment',
  existing_owner: 'Kept from the existing policy owner',
  producer_mapping: 'Assigned from the imported producer label',
  weighted_auto: 'Assigned by weighted workload balancing',
  manager: 'Assigned by a manager',
};

/** How a manager configured one employee for automatic balancing (Requirement 3.4). */
export type PolicyAssignmentMode = 'automatic' | 'producer_preferred' | 'manual_only';

export const POLICY_ASSIGNMENT_MODES = [
  'automatic',
  'producer_preferred',
  'manual_only',
] as const satisfies readonly PolicyAssignmentMode[];

export const POLICY_ASSIGNMENT_MODE_LABELS: Readonly<Record<PolicyAssignmentMode, string>> = {
  automatic: 'Automatic — receives producer-mapped and workload-balanced policies',
  producer_preferred: 'Producer preferred — receives their own producer label first, then balancing',
  manual_only: 'Manual only — receives nothing automatically',
};

/** True where an employee may receive an automatically balanced policy (Requirement 3.4). */
export function acceptsAutomaticBalancing(mode: PolicyAssignmentMode): boolean {
  return mode !== 'manual_only';
}
