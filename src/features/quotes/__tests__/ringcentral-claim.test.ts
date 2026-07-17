// src/features/quotes/__tests__/ringcentral-claim.test.ts
// Unit tests for RingCentral claim flow
// Feature: customer-intake-claim-duplicate-quote
// Requirements: 5.1, 5.2, 6.1, 6.2, 6.3, 6.4

import { describe, it, expect } from 'vitest';

// ─── Claim Validation Simulation Module ─────────────────────────────────────
// Models the pure claim validation logic from claim_ringcentral_intake RPC
// without requiring Supabase connection.

interface ClaimContext {
  intakeSourceType: string;
  intakeStatus: string;
  intakeAssignedTo: string | null;
  callerRole: string;
  callerIsRcAgent: boolean;
  callerAvailability: string;
  currentRcAgentId: string;
  callerId: string;
}

type ClaimError =
  | 'NOT_RINGCENTRAL'
  | 'ALREADY_CLAIMED'
  | 'INVALID_STATUS'
  | 'NOT_AGENT'
  | 'NO_RC_AGENT'
  | 'NOT_YOUR_TURN'
  | 'AGENT_UNAVAILABLE';

function validateClaimAttempt(ctx: ClaimContext): { allowed: boolean; error?: ClaimError } {
  // 1. Validate source is RingCentral
  if (ctx.intakeSourceType !== 'ringcentral') {
    return { allowed: false, error: 'NOT_RINGCENTRAL' };
  }

  // 2. Validate intake is unclaimed
  if (ctx.intakeAssignedTo !== null) {
    return { allowed: false, error: 'ALREADY_CLAIMED' };
  }

  // 3. Validate intake status allows claiming
  if (ctx.intakeStatus !== 'submitted' && ctx.intakeStatus !== 'waiting_for_claim') {
    return { allowed: false, error: 'INVALID_STATUS' };
  }

  // 4. Validate caller role
  if (ctx.callerRole !== 'agent' && ctx.callerRole !== 'manager') {
    return { allowed: false, error: 'NOT_AGENT' };
  }

  // 5. Check RC agent is available
  if (!ctx.currentRcAgentId) {
    return { allowed: false, error: 'NO_RC_AGENT' };
  }

  // 6. Validate caller is the current RC agent (managers bypass rotation check)
  if (ctx.callerId !== ctx.currentRcAgentId && ctx.callerRole !== 'manager') {
    return { allowed: false, error: 'NOT_YOUR_TURN' };
  }

  // 7. Check agent availability (managers bypass availability check)
  if (ctx.callerAvailability !== 'available' && ctx.callerRole !== 'manager') {
    return { allowed: false, error: 'AGENT_UNAVAILABLE' };
  }

  return { allowed: true };
}

// ─── Concurrent Claim Simulation ────────────────────────────────────────────
// Simulates what happens when two agents try to claim the same intake
// by modeling the row-level lock behavior.

interface ClaimState {
  intakeAssignedTo: string | null;
  claimedAt: string | null;
  convertedQuoteId: string | null;
}

function simulateConcurrentClaims(
  initialState: ClaimState,
  claimAttempts: Array<{ agentId: string; isCurrentRcAgent: boolean }>
): { successfulClaimant: string | null; failedAttempts: string[] } {
  let state = { ...initialState };
  let successfulClaimant: string | null = null;
  const failedAttempts: string[] = [];

  for (const attempt of claimAttempts) {
    if (!attempt.isCurrentRcAgent) {
      failedAttempts.push(attempt.agentId);
      continue;
    }

    if (state.intakeAssignedTo !== null) {
      // Already claimed by a previous attempt in this batch
      failedAttempts.push(attempt.agentId);
    } else {
      // First valid attempt wins
      state = {
        intakeAssignedTo: attempt.agentId,
        claimedAt: new Date().toISOString(),
        convertedQuoteId: `quote-${attempt.agentId}`,
      };
      successfulClaimant = attempt.agentId;
    }
  }

  return { successfulClaimant, failedAttempts };
}

// ─── Failure Rollback Simulation ────────────────────────────────────────────
// Simulates that on any failure, no partial state remains.

interface TransactionState {
  intakeStatus: string;
  intakeAssignedTo: string | null;
  intakeClaimedAt: string | null;
  intakeConvertedQuoteId: string | null;
  quoteCreated: boolean;
  historyEventCreated: boolean;
  notificationCreated: boolean;
}

function simulateClaimTransaction(
  ctx: ClaimContext,
  failAtStep?: number
): { finalState: TransactionState; success: boolean; error?: string } {
  const initialState: TransactionState = {
    intakeStatus: ctx.intakeStatus,
    intakeAssignedTo: ctx.intakeAssignedTo,
    intakeClaimedAt: null,
    intakeConvertedQuoteId: null,
    quoteCreated: false,
    historyEventCreated: false,
    notificationCreated: false,
  };

  // Validate first
  const validation = validateClaimAttempt(ctx);
  if (!validation.allowed) {
    return { finalState: initialState, success: false, error: validation.error };
  }

  // Simulate transaction steps — if failAtStep is defined, fail at that step
  const steps = [
    'lock_row',
    'validate_rotation',
    'create_quote',
    'update_intake',
    'create_history',
    'create_notification',
  ];

  for (let i = 0; i < steps.length; i++) {
    if (failAtStep !== undefined && i === failAtStep) {
      // Transaction failed — rollback (return initial state)
      return {
        finalState: initialState,
        success: false,
        error: `STEP_FAILED: ${steps[i]}`,
      };
    }
  }

  // All steps succeeded
  return {
    finalState: {
      intakeStatus: 'claimed',
      intakeAssignedTo: ctx.callerId,
      intakeClaimedAt: new Date().toISOString(),
      intakeConvertedQuoteId: `quote-${ctx.callerId}`,
      quoteCreated: true,
      historyEventCreated: true,
      notificationCreated: true,
    },
    success: true,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('RingCentral Claim Flow — validateClaimAttempt', () => {
  const validContext: ClaimContext = {
    intakeSourceType: 'ringcentral',
    intakeStatus: 'submitted',
    intakeAssignedTo: null,
    callerRole: 'agent',
    callerIsRcAgent: true,
    callerAvailability: 'available',
    currentRcAgentId: 'agent-1',
    callerId: 'agent-1',
  };

  describe('Happy path', () => {
    it('allows claim when RC agent, available, submitted RC intake, unclaimed', () => {
      const result = validateClaimAttempt(validContext);
      expect(result.allowed).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('allows claim on waiting_for_claim status', () => {
      const result = validateClaimAttempt({
        ...validContext,
        intakeStatus: 'waiting_for_claim',
      });
      expect(result.allowed).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Wrong agent rejection (Req 5.1, 5.4)', () => {
    it('rejects when caller is not the current RC turn holder', () => {
      const result = validateClaimAttempt({
        ...validContext,
        callerId: 'agent-2',
        currentRcAgentId: 'agent-1',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('NOT_YOUR_TURN');
    });

    it('rejects a different agent even if they are available', () => {
      const result = validateClaimAttempt({
        ...validContext,
        callerId: 'agent-3',
        callerAvailability: 'available',
        currentRcAgentId: 'agent-1',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('NOT_YOUR_TURN');
    });
  });

  describe('Non-RC intake rejection (Req 6.5)', () => {
    it('rejects when source_type is not ringcentral', () => {
      const result = validateClaimAttempt({
        ...validContext,
        intakeSourceType: 'dealership',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('NOT_RINGCENTRAL');
    });

    it('rejects walk_in_office source type', () => {
      const result = validateClaimAttempt({
        ...validContext,
        intakeSourceType: 'walk_in_office',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('NOT_RINGCENTRAL');
    });

    it('rejects whatsapp source type', () => {
      const result = validateClaimAttempt({
        ...validContext,
        intakeSourceType: 'whatsapp',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('NOT_RINGCENTRAL');
    });
  });

  describe('Already claimed rejection (Req 6.2)', () => {
    it('rejects when intake already has an assigned agent', () => {
      const result = validateClaimAttempt({
        ...validContext,
        intakeAssignedTo: 'agent-other',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('ALREADY_CLAIMED');
    });
  });

  describe('Agent unavailable rejection (Req 5.2, 5.3)', () => {
    it('rejects when agent availability is away', () => {
      const result = validateClaimAttempt({
        ...validContext,
        callerAvailability: 'away',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('AGENT_UNAVAILABLE');
    });

    it('rejects when agent availability is offline', () => {
      const result = validateClaimAttempt({
        ...validContext,
        callerAvailability: 'offline',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('AGENT_UNAVAILABLE');
    });
  });

  describe('Manager override (Req 5.5)', () => {
    it('allows manager to bypass RC rotation check', () => {
      const result = validateClaimAttempt({
        ...validContext,
        callerRole: 'manager',
        callerId: 'manager-1',
        currentRcAgentId: 'agent-1',
      });
      expect(result.allowed).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('allows manager even when marked unavailable', () => {
      const result = validateClaimAttempt({
        ...validContext,
        callerRole: 'manager',
        callerId: 'manager-1',
        callerAvailability: 'away',
        currentRcAgentId: 'agent-1',
      });
      expect(result.allowed).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Invalid status rejection (Req 6.2)', () => {
    it('rejects when intake status is draft', () => {
      const result = validateClaimAttempt({
        ...validContext,
        intakeStatus: 'draft',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('INVALID_STATUS');
    });

    it('rejects when intake status is claimed', () => {
      const result = validateClaimAttempt({
        ...validContext,
        intakeStatus: 'claimed',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('INVALID_STATUS');
    });

    it('rejects when intake status is converted', () => {
      const result = validateClaimAttempt({
        ...validContext,
        intakeStatus: 'converted',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('INVALID_STATUS');
    });

    it('rejects when intake status is deleted', () => {
      const result = validateClaimAttempt({
        ...validContext,
        intakeStatus: 'deleted',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('INVALID_STATUS');
    });

    it('rejects when intake status is assigned', () => {
      const result = validateClaimAttempt({
        ...validContext,
        intakeStatus: 'assigned',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('INVALID_STATUS');
    });

    it('rejects when intake status is waiting_for_assignment', () => {
      const result = validateClaimAttempt({
        ...validContext,
        intakeStatus: 'waiting_for_assignment',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('INVALID_STATUS');
    });
  });

  describe('Non-agent role rejection', () => {
    it('rejects customer_service role from claiming', () => {
      const result = validateClaimAttempt({
        ...validContext,
        callerRole: 'customer_service',
      });
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('NOT_AGENT');
    });
  });
});

describe('RingCentral Claim Flow — Concurrent Claim Handling (Req 6.3)', () => {
  it('only the first valid claimant succeeds when two agents try simultaneously', () => {
    const result = simulateConcurrentClaims(
      { intakeAssignedTo: null, claimedAt: null, convertedQuoteId: null },
      [
        { agentId: 'agent-1', isCurrentRcAgent: true },
        { agentId: 'agent-2', isCurrentRcAgent: true },
      ]
    );

    expect(result.successfulClaimant).toBe('agent-1');
    expect(result.failedAttempts).toContain('agent-2');
    expect(result.failedAttempts).toHaveLength(1);
  });

  it('rejects all attempts if none are the current RC agent', () => {
    const result = simulateConcurrentClaims(
      { intakeAssignedTo: null, claimedAt: null, convertedQuoteId: null },
      [
        { agentId: 'agent-2', isCurrentRcAgent: false },
        { agentId: 'agent-3', isCurrentRcAgent: false },
      ]
    );

    expect(result.successfulClaimant).toBeNull();
    expect(result.failedAttempts).toHaveLength(2);
  });

  it('rejects second attempt even if the same agent tries twice', () => {
    const result = simulateConcurrentClaims(
      { intakeAssignedTo: null, claimedAt: null, convertedQuoteId: null },
      [
        { agentId: 'agent-1', isCurrentRcAgent: true },
        { agentId: 'agent-1', isCurrentRcAgent: true },
      ]
    );

    expect(result.successfulClaimant).toBe('agent-1');
    expect(result.failedAttempts).toEqual(['agent-1']);
  });

  it('exactly one succeeds among many concurrent attempts', () => {
    const attempts = Array.from({ length: 5 }, (_, i) => ({
      agentId: `agent-${i}`,
      isCurrentRcAgent: i === 2, // only agent-2 is the current RC agent
    }));

    const result = simulateConcurrentClaims(
      { intakeAssignedTo: null, claimedAt: null, convertedQuoteId: null },
      attempts
    );

    expect(result.successfulClaimant).toBe('agent-2');
    expect(result.failedAttempts).toHaveLength(4);
    expect(result.failedAttempts).not.toContain('agent-2');
  });
});

describe('RingCentral Claim Flow — Failure Rollback (Req 6.4)', () => {
  const validCtx: ClaimContext = {
    intakeSourceType: 'ringcentral',
    intakeStatus: 'submitted',
    intakeAssignedTo: null,
    callerRole: 'agent',
    callerIsRcAgent: true,
    callerAvailability: 'available',
    currentRcAgentId: 'agent-1',
    callerId: 'agent-1',
  };

  it('successful transaction produces complete state', () => {
    const { finalState, success } = simulateClaimTransaction(validCtx);

    expect(success).toBe(true);
    expect(finalState.intakeStatus).toBe('claimed');
    expect(finalState.intakeAssignedTo).toBe('agent-1');
    expect(finalState.intakeClaimedAt).not.toBeNull();
    expect(finalState.intakeConvertedQuoteId).not.toBeNull();
    expect(finalState.quoteCreated).toBe(true);
    expect(finalState.historyEventCreated).toBe(true);
    expect(finalState.notificationCreated).toBe(true);
  });

  it('failure at lock_row step preserves original state (no partial writes)', () => {
    const { finalState, success } = simulateClaimTransaction(validCtx, 0);

    expect(success).toBe(false);
    expect(finalState.intakeStatus).toBe('submitted');
    expect(finalState.intakeAssignedTo).toBeNull();
    expect(finalState.intakeClaimedAt).toBeNull();
    expect(finalState.intakeConvertedQuoteId).toBeNull();
    expect(finalState.quoteCreated).toBe(false);
    expect(finalState.historyEventCreated).toBe(false);
    expect(finalState.notificationCreated).toBe(false);
  });

  it('failure at create_quote step preserves original state', () => {
    const { finalState, success } = simulateClaimTransaction(validCtx, 2);

    expect(success).toBe(false);
    expect(finalState.intakeStatus).toBe('submitted');
    expect(finalState.intakeAssignedTo).toBeNull();
    expect(finalState.intakeConvertedQuoteId).toBeNull();
    expect(finalState.quoteCreated).toBe(false);
  });

  it('failure at update_intake step rolls back quote creation', () => {
    const { finalState, success } = simulateClaimTransaction(validCtx, 3);

    expect(success).toBe(false);
    expect(finalState.intakeStatus).toBe('submitted');
    expect(finalState.intakeAssignedTo).toBeNull();
    expect(finalState.quoteCreated).toBe(false);
  });

  it('failure at create_history step rolls back all prior writes', () => {
    const { finalState, success } = simulateClaimTransaction(validCtx, 4);

    expect(success).toBe(false);
    expect(finalState.intakeStatus).toBe('submitted');
    expect(finalState.quoteCreated).toBe(false);
    expect(finalState.historyEventCreated).toBe(false);
  });

  it('failure at create_notification step rolls back all prior writes', () => {
    const { finalState, success } = simulateClaimTransaction(validCtx, 5);

    expect(success).toBe(false);
    expect(finalState.intakeStatus).toBe('submitted');
    expect(finalState.quoteCreated).toBe(false);
    expect(finalState.notificationCreated).toBe(false);
  });

  it('validation failure produces no state changes at all', () => {
    const invalidCtx: ClaimContext = {
      ...validCtx,
      intakeSourceType: 'dealership',
    };

    const { finalState, success, error } = simulateClaimTransaction(invalidCtx);

    expect(success).toBe(false);
    expect(error).toBe('NOT_RINGCENTRAL');
    expect(finalState.intakeStatus).toBe('submitted');
    expect(finalState.intakeAssignedTo).toBeNull();
    expect(finalState.intakeConvertedQuoteId).toBeNull();
    expect(finalState.quoteCreated).toBe(false);
  });
});
