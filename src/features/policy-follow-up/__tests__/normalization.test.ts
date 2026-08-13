import { describe, expect, it } from 'vitest';

import {
  acceptsAutomaticBalancing,
  communicationBlocked,
  foldSourceValue,
  isCarrierNonRenewal,
  normalizeCarrierKey,
  normalizeMatch,
  normalizePolicyNumber,
  normalizeSourceState,
  POLICY_SOURCE_STATES,
  POLICY_SOURCE_STATE_LABELS,
  policyIdentity,
  policyIdentityKey,
  policyReviewReasons,
  type PolicyReviewReasonCode,
} from '../normalization';

// ---------------------------------------------------------------------------
// foldSourceValue
// ---------------------------------------------------------------------------

describe('foldSourceValue', () => {
  it('removes accents, collapses whitespace runs, and folds case', () => {
    expect(foldSourceValue('  Cancelación   Pendiente ')).toBe('cancelacion pendiente');
    expect(foldSourceValue('NO   RENUEVA')).toBe('no renueva');
  });

  it('folds an absent value to the empty string rather than throwing', () => {
    expect(foldSourceValue(null)).toBe('');
    expect(foldSourceValue(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// normalizeSourceState (Requirements 1.2, 1.3, 7.2)
// ---------------------------------------------------------------------------

describe('normalizeSourceState', () => {
  it('maps the renewal vocabulary', () => {
    for (const raw of ['Renovación', 'renovacion', 'Renewal', 'Activa', 'Vigente']) {
      expect(normalizeSourceState(raw).state).toBe('renewal');
    }
  });

  it('maps No renueva to Carrier Non-Renewal and never to Lost', () => {
    for (const raw of ['No renueva', 'NO RENUEVA', 'no  renovacion', 'Non-Renewal']) {
      const normalized = normalizeSourceState(raw);
      expect(normalized.state).toBe('carrier_nonrenewal');
      expect(normalized.label).toBe('Carrier Non-Renewal / Requote Required');
      expect(normalized.label).not.toContain('Lost');
    }
  });

  it('reads an annotated No renueva value by its leading token', () => {
    const normalized = normalizeSourceState('No renueva - carta del carrier 01/2026');

    expect(normalized.state).toBe('carrier_nonrenewal');
    expect(normalized.unrecognized).toBe(false);
    // Requirement 1.1: the annotation survives untouched.
    expect(normalized.raw).toBe('No renueva - carta del carrier 01/2026');
  });

  it('maps the three cancellation machine values', () => {
    expect(normalizeSourceState('pending').state).toBe('pending_cancellation');
    expect(normalizeSourceState('paid_signal').state).toBe('payment_signal');
    expect(normalizeSourceState('cancelled_signal').state).toBe('cancelled_signal');
  });

  it('maps the Spanish cancellation vocabulary', () => {
    expect(normalizeSourceState('Cancelación pendiente').state).toBe('pending_cancellation');
    expect(normalizeSourceState('Pagada').state).toBe('payment_signal');
    expect(normalizeSourceState('Recuperada').state).toBe('payment_signal');
    expect(normalizeSourceState('Cancelada').state).toBe('cancelled_signal');
    expect(normalizeSourceState('Perdida').state).toBe('cancelled_signal');
  });

  it('sends an unrecognized value to review and preserves it verbatim (Req 1.3)', () => {
    const normalized = normalizeSourceState('Estado raro del carrier');

    expect(normalized.state).toBe('review_required');
    expect(normalized.unrecognized).toBe(true);
    expect(normalized.raw).toBe('Estado raro del carrier');
  });

  it('never replaces a populated unrecognized value with the fallback', () => {
    const normalized = normalizeSourceState('Estado raro del carrier', 'renewal');

    expect(normalized.state).toBe('review_required');
    expect(normalized.unrecognized).toBe(true);
  });

  it('uses the fallback only for an absent value', () => {
    expect(normalizeSourceState('', 'renewal').state).toBe('renewal');
    expect(normalizeSourceState('   ', 'renewal').state).toBe('renewal');
    expect(normalizeSourceState(null, 'renewal').unrecognized).toBe(false);
  });

  it('sends an absent value with no fallback to review', () => {
    const normalized = normalizeSourceState(null);

    expect(normalized.state).toBe('review_required');
    expect(normalized.unrecognized).toBe(true);
    expect(normalized.raw).toBeNull();
  });

  it('labels every state', () => {
    for (const state of POLICY_SOURCE_STATES) {
      expect(POLICY_SOURCE_STATE_LABELS[state].length).toBeGreaterThan(0);
    }
  });

  it('identifies the carrier non-renewal state', () => {
    expect(isCarrierNonRenewal('carrier_nonrenewal')).toBe(true);
    expect(isCarrierNonRenewal('renewal')).toBe(false);
    expect(isCarrierNonRenewal(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeMatch (Requirement 1.4)
// ---------------------------------------------------------------------------

describe('normalizeMatch', () => {
  it('reads an exact match as eligible for the normal workflow', () => {
    for (const raw of ['Exacto', 'exact', 'Sí', 'TRUE', '1']) {
      const match = normalizeMatch(raw, 'ClienteID');
      expect(match.confidence).toBe('exact');
      expect(match.permitsAutomaticWorkflow).toBe(true);
    }
  });

  it('reads a probable match as review-required', () => {
    const match = normalizeMatch('Probable', 'Nombre');

    expect(match.confidence).toBe('probable');
    expect(match.permitsAutomaticWorkflow).toBe(false);
  });

  it('reads an explicit non-match as review-required', () => {
    for (const raw of ['No', 'Sin cruce', 'no match', '0']) {
      expect(normalizeMatch(raw).confidence).toBe('no_match');
    }
  });

  it('treats an empty pair as no match rather than as an exact one', () => {
    const match = normalizeMatch(null, null);

    expect(match.confidence).toBe('no_match');
    expect(match.permitsAutomaticWorkflow).toBe(false);
  });

  it('falls back to the method only when the status cell is empty', () => {
    expect(normalizeMatch('', 'Probable').confidence).toBe('probable');
    // A populated status decides, even when the method disagrees.
    expect(normalizeMatch('Exacto', 'Probable').confidence).toBe('exact');
  });

  it('reads an unrecognized result as unknown and blocks it', () => {
    const match = normalizeMatch('cruce raro');

    expect(match.confidence).toBe('unknown');
    expect(match.permitsAutomaticWorkflow).toBe(false);
    expect(match.rawStatus).toBe('cruce raro');
  });

  it('preserves both raw values (Req 1.1)', () => {
    const match = normalizeMatch(' Probable ', ' Nombre + Poliza ');

    expect(match.rawStatus).toBe('Probable');
    expect(match.rawMethod).toBe('Nombre + Poliza');
  });
});

// ---------------------------------------------------------------------------
// policyReviewReasons / communicationBlocked (Requirements 1.3, 1.4, 8.3, 12.2)
// ---------------------------------------------------------------------------

describe('policyReviewReasons', () => {
  const codes = (input: Parameters<typeof policyReviewReasons>[0]): PolicyReviewReasonCode[] =>
    policyReviewReasons(input).map((reason) => reason.code);

  it('is empty for a recognized state with an exact match', () => {
    expect(codes({ state: 'renewal', unrecognizedState: false, confidence: 'exact' })).toEqual([]);
    expect(communicationBlocked({ state: 'renewal', unrecognizedState: false, confidence: 'exact' }))
      .toBe(false);
  });

  it('blocks a probable match', () => {
    expect(codes({ state: 'renewal', unrecognizedState: false, confidence: 'probable' }))
      .toEqual(['match_probable']);
  });

  it('blocks an absent match', () => {
    expect(codes({ state: 'renewal', unrecognizedState: false, confidence: 'no_match' }))
      .toEqual(['match_missing']);
  });

  it('blocks an unrecognized source state', () => {
    expect(codes({ state: 'review_required', unrecognizedState: true, confidence: 'exact' }))
      .toEqual(['unrecognized_source_state']);
  });

  it('blocks an estimated cancellation date (Req 8.3)', () => {
    expect(codes({
      state: 'pending_cancellation',
      unrecognizedState: false,
      confidence: 'exact',
      estimatedEffectiveDate: true,
    })).toEqual(['estimated_cancellation_date']);
  });

  it('blocks a row with no readable carrier', () => {
    expect(codes({
      state: 'renewal',
      unrecognizedState: false,
      confidence: 'exact',
      carrierMissing: true,
    })).toEqual(['carrier_identity_missing']);
  });

  it('collects every reason in a fixed order', () => {
    expect(codes({
      state: 'review_required',
      unrecognizedState: true,
      confidence: 'probable',
      estimatedEffectiveDate: true,
      carrierMissing: true,
    })).toEqual([
      'unrecognized_source_state',
      'match_probable',
      'estimated_cancellation_date',
      'carrier_identity_missing',
    ]);
  });

  it('names one action per reason', () => {
    for (const reason of policyReviewReasons({
      state: 'review_required',
      unrecognizedState: true,
      confidence: 'no_match',
      estimatedEffectiveDate: true,
    })) {
      expect(reason.message.length).toBeGreaterThan(20);
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeCarrierKey (Requirement 3.1, design 4.2)
// ---------------------------------------------------------------------------

describe('normalizeCarrierKey', () => {
  it('folds punctuation, spacing, and case to one key', () => {
    expect(normalizeCarrierKey('Progressive')).toBe('PROGRESSIVE');
    expect(normalizeCarrierKey('PROGRESSIVE INSURANCE')).toBe('PROGRESSIVE');
    expect(normalizeCarrierKey('progressive-insurance')).toBe('PROGRESSIVE');
    expect(normalizeCarrierKey('  Progressive  Insurance  ')).toBe('PROGRESSIVE');
  });

  it('resolves confirmed display aliases', () => {
    expect(normalizeCarrierKey('NatGen')).toBe('NATIONALGENERAL');
    expect(normalizeCarrierKey('National General')).toBe('NATIONALGENERAL');
    expect(normalizeCarrierKey('United Auto')).toBe('UNITEDAUTOMOBILE');
    expect(normalizeCarrierKey('UAIC')).toBe('UNITEDAUTOMOBILE');
  });

  it('removes accents before folding', () => {
    expect(normalizeCarrierKey('Compañía Ejemplo')).toBe('COMPANIAEJEMPLO');
  });

  it('does NOT merge two carriers on fuzzy similarity', () => {
    // A typo nobody confirmed keys to itself, which produces a visible duplicate a manager can
    // correct rather than a silent cross-carrier ownership link (design 4.2).
    expect(normalizeCarrierKey('Progresive')).toBe('PROGRESIVE');
    expect(normalizeCarrierKey('Progresive')).not.toBe(normalizeCarrierKey('Progressive'));
  });

  it('returns null for a value naming no carrier', () => {
    expect(normalizeCarrierKey(null)).toBeNull();
    expect(normalizeCarrierKey('')).toBeNull();
    expect(normalizeCarrierKey('   ')).toBeNull();
    expect(normalizeCarrierKey('---')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizePolicyNumber and policyIdentity (Requirement 3.1)
// ---------------------------------------------------------------------------

describe('normalizePolicyNumber', () => {
  it('matches the cancellation_cases generated column definition', () => {
    // upper(regexp_replace(policy_number, '\s', '', 'g'))
    expect(normalizePolicyNumber(' abc 123 ')).toBe('ABC123');
    expect(normalizePolicyNumber('pol\t9\n9')).toBe('POL99');
  });

  it('keeps every non-whitespace character, including hyphens and leading zeros', () => {
    expect(normalizePolicyNumber('0012-AB')).toBe('0012-AB');
    expect(normalizePolicyNumber('0012AB')).not.toBe(normalizePolicyNumber('0012-AB'));
  });

  it('returns null for a value naming no policy', () => {
    expect(normalizePolicyNumber(null)).toBeNull();
    expect(normalizePolicyNumber('   ')).toBeNull();
  });
});

describe('policyIdentity', () => {
  it('is the normalized carrier key and policy number', () => {
    expect(policyIdentity('Progressive Insurance', ' pol 123 ')).toEqual({
      carrierKey: 'PROGRESSIVE',
      policyNumberNormalized: 'POL123',
    });
  });

  it('is null when either half is missing, so no ownership link is invented', () => {
    expect(policyIdentity(null, 'POL123')).toBeNull();
    expect(policyIdentity('Progressive', null)).toBeNull();
  });

  it('is stable across the two domains for the same policy', () => {
    const fromRenewal = policyIdentity('NatGen', 'AB-1000');
    const fromCancellation = policyIdentity('National General Insurance', ' ab-1000 ');

    expect(fromRenewal).not.toBeNull();
    expect(fromCancellation).toEqual(fromRenewal);
    expect(policyIdentityKey(fromRenewal!)).toBe('NATIONALGENERAL|AB-1000');
  });

  it('does not key on customer name', () => {
    // The same policy spelled three ways across three systems still keys to one identity.
    expect(policyIdentity('Progressive', 'POL1')).toEqual(policyIdentity('progressive', 'pol1'));
  });
});

// ---------------------------------------------------------------------------
// Assignment modes (Requirement 3.4)
// ---------------------------------------------------------------------------

describe('acceptsAutomaticBalancing', () => {
  it('excludes manual-only employees and nobody else', () => {
    expect(acceptsAutomaticBalancing('automatic')).toBe(true);
    expect(acceptsAutomaticBalancing('producer_preferred')).toBe(true);
    expect(acceptsAutomaticBalancing('manual_only')).toBe(false);
  });
});
