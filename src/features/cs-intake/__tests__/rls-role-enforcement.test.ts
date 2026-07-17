import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

// Feature: customer-intake-claim-duplicate-quote, Property 13 (PBT-13): RLS Role Enforcement
// **Validates: Requirements 27.1, 27.2, 27.3, 27.4, 27.5**

// ─── Pure functions mirroring RLS policy logic ───────────────────────────────

type Role = 'customer_service' | 'agent' | 'manager';

type IntakeStatus =
  | 'draft'
  | 'submitted'
  | 'waiting_for_claim'
  | 'waiting_for_assignment'
  | 'claimed'
  | 'assigned'
  | 'converted'
  | 'deleted';

interface IntakeRow {
  id: string;
  created_by: string;
  status: IntakeStatus;
}

interface HistoryEventRow {
  id: string;
  intake_id: string;
  actor_id: string;
}

// RLS policy: cs_select_own — CS user can only SELECT their own intakes
function canCsSelectIntake(userId: string, intake: IntakeRow): boolean {
  return intake.created_by === userId;
}

// RLS policy: cs_update_own — CS user can only UPDATE their own intakes
function canCsUpdateIntake(userId: string, intake: IntakeRow): boolean {
  return intake.created_by === userId;
}

// RLS policy: agent_select_queue — Agent can view intakes NOT in draft or deleted status
function canAgentSelectIntake(_userId: string, intake: IntakeRow): boolean {
  return intake.status !== 'draft' && intake.status !== 'deleted';
}

// RLS policy: manager_select_all — Manager can view ALL intakes (including deleted)
function canManagerSelectIntake(_userId: string, _intake: IntakeRow): boolean {
  return true;
}

// RLS policy: manager_update_all — Manager can update ANY intake
function canManagerUpdateIntake(_userId: string, _intake: IntakeRow): boolean {
  return true;
}

// Combined: determines if a user with a given role can SELECT an intake
function canSelectIntake(role: Role, userId: string, intake: IntakeRow): boolean {
  switch (role) {
    case 'customer_service':
      return canCsSelectIntake(userId, intake);
    case 'agent':
      return canAgentSelectIntake(userId, intake);
    case 'manager':
      return canManagerSelectIntake(userId, intake);
  }
}

// Combined: determines if a user with a given role can UPDATE an intake
function canUpdateIntake(role: Role, userId: string, intake: IntakeRow): boolean {
  switch (role) {
    case 'customer_service':
      return canCsUpdateIntake(userId, intake);
    case 'agent':
      // Agents have no direct UPDATE policy on customer_intakes
      return false;
    case 'manager':
      return canManagerUpdateIntake(userId, intake);
  }
}

// RPC authorization: which roles can call which RPC functions
type RpcFunction =
  | 'claim_ringcentral_intake'
  | 'assign_customer_intake'
  | 'flag_quote_duplicate'
  | 'resolve_quote_duplicate'
  | 'merge_quote_records'
  | 'delete_customer_intake'
  | 'restore_customer_intake'
  | 'update_customer_intake';

function canCallRpc(role: Role, rpcFunction: RpcFunction): boolean {
  switch (rpcFunction) {
    case 'claim_ringcentral_intake':
      // Only agents and managers (Req 27.2, 27.3)
      return role === 'agent' || role === 'manager';
    case 'assign_customer_intake':
      // Only managers (Req 27.3)
      return role === 'manager';
    case 'flag_quote_duplicate':
      // Agents and managers (Req 27.2, 27.3)
      return role === 'agent' || role === 'manager';
    case 'resolve_quote_duplicate':
      // Only managers (Req 27.3)
      return role === 'manager';
    case 'merge_quote_records':
      // Only managers (Req 27.3)
      return role === 'manager';
    case 'delete_customer_intake':
      // Only managers (Req 27.3)
      return role === 'manager';
    case 'restore_customer_intake':
      // Only managers (Req 27.3)
      return role === 'manager';
    case 'update_customer_intake':
      // CS (own intakes) and managers (any intake) (Req 27.1, 27.3)
      return role === 'customer_service' || role === 'manager';
  }
}

// History events immutability: no role can UPDATE or DELETE history events
function canUpdateHistoryEvent(_role: Role, _userId: string, _event: HistoryEventRow): boolean {
  return false;
}

function canDeleteHistoryEvent(_role: Role, _userId: string, _event: HistoryEventRow): boolean {
  return false;
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const roleArb = fc.constantFrom<Role>('customer_service', 'agent', 'manager');
const uuidArb = fc.uuid();
const intakeStatusArb = fc.constantFrom<IntakeStatus>(
  'draft',
  'submitted',
  'waiting_for_claim',
  'waiting_for_assignment',
  'claimed',
  'assigned',
  'converted',
  'deleted'
);

const intakeRowArb = fc.record({
  id: uuidArb,
  created_by: uuidArb,
  status: intakeStatusArb,
});

const historyEventArb = fc.record({
  id: uuidArb,
  intake_id: uuidArb,
  actor_id: uuidArb,
});

const rpcFunctionArb = fc.constantFrom<RpcFunction>(
  'claim_ringcentral_intake',
  'assign_customer_intake',
  'flag_quote_duplicate',
  'resolve_quote_duplicate',
  'merge_quote_records',
  'delete_customer_intake',
  'restore_customer_intake',
  'update_customer_intake'
);

// CS-unauthorized RPC functions: functions CS_Users should never be able to call
const csUnauthorizedRpcArb = fc.constantFrom<RpcFunction>(
  'claim_ringcentral_intake',
  'assign_customer_intake',
  'resolve_quote_duplicate',
  'merge_quote_records',
  'delete_customer_intake',
  'restore_customer_intake'
);

// Agent-unauthorized RPC functions: functions Agents should never be able to call
const agentUnauthorizedRpcArb = fc.constantFrom<RpcFunction>(
  'assign_customer_intake',
  'delete_customer_intake',
  'restore_customer_intake',
  'resolve_quote_duplicate',
  'merge_quote_records'
);

// ─── Property Tests ──────────────────────────────────────────────────────────

describe('PBT-13: RLS Role Enforcement', () => {
  describe('CS_User intake access (Req 27.1)', () => {
    it('CS user can only SELECT intakes they created', () => {
      fc.assert(
        fc.property(uuidArb, intakeRowArb, (userId, intake) => {
          const canSelect = canSelectIntake('customer_service', userId, intake);
          if (intake.created_by === userId) {
            expect(canSelect).toBe(true);
          } else {
            expect(canSelect).toBe(false);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('CS user can only UPDATE intakes they created', () => {
      fc.assert(
        fc.property(uuidArb, intakeRowArb, (userId, intake) => {
          const canUpdate = canUpdateIntake('customer_service', userId, intake);
          if (intake.created_by === userId) {
            expect(canUpdate).toBe(true);
          } else {
            expect(canUpdate).toBe(false);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('CS user is rejected from unauthorized RPC functions', () => {
      fc.assert(
        fc.property(csUnauthorizedRpcArb, (rpcFn) => {
          expect(canCallRpc('customer_service', rpcFn)).toBe(false);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Agent intake access (Req 27.2)', () => {
    it('Agent can view non-draft, non-deleted intakes', () => {
      fc.assert(
        fc.property(uuidArb, intakeRowArb, (userId, intake) => {
          const canSelect = canSelectIntake('agent', userId, intake);
          if (intake.status === 'draft' || intake.status === 'deleted') {
            expect(canSelect).toBe(false);
          } else {
            expect(canSelect).toBe(true);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('Agent cannot directly UPDATE intakes (must use RPC)', () => {
      fc.assert(
        fc.property(uuidArb, intakeRowArb, (userId, intake) => {
          expect(canUpdateIntake('agent', userId, intake)).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('Agent is rejected from unauthorized RPC functions', () => {
      fc.assert(
        fc.property(agentUnauthorizedRpcArb, (rpcFn) => {
          expect(canCallRpc('agent', rpcFn)).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('Agent can call claim and flag duplicate RPC functions', () => {
      const agentAllowedRpcArb = fc.constantFrom<RpcFunction>(
        'claim_ringcentral_intake',
        'flag_quote_duplicate'
      );

      fc.assert(
        fc.property(agentAllowedRpcArb, (rpcFn) => {
          expect(canCallRpc('agent', rpcFn)).toBe(true);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Manager full access (Req 27.3)', () => {
    it('Manager can view all intakes regardless of status or ownership', () => {
      fc.assert(
        fc.property(uuidArb, intakeRowArb, (userId, intake) => {
          expect(canSelectIntake('manager', userId, intake)).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('Manager can update any intake regardless of ownership', () => {
      fc.assert(
        fc.property(uuidArb, intakeRowArb, (userId, intake) => {
          expect(canUpdateIntake('manager', userId, intake)).toBe(true);
        }),
        { numRuns: 100 }
      );
    });

    it('Manager can call all RPC functions', () => {
      fc.assert(
        fc.property(rpcFunctionArb, (rpcFn) => {
          expect(canCallRpc('manager', rpcFn)).toBe(true);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('History event immutability (Req 27.4, 27.5)', () => {
    it('no role can UPDATE history events', () => {
      fc.assert(
        fc.property(roleArb, uuidArb, historyEventArb, (role, userId, event) => {
          expect(canUpdateHistoryEvent(role, userId, event)).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('no role can DELETE history events', () => {
      fc.assert(
        fc.property(roleArb, uuidArb, historyEventArb, (role, userId, event) => {
          expect(canDeleteHistoryEvent(role, userId, event)).toBe(false);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Cross-role authorization matrix with random combinations (Req 27.1-27.5)', () => {
    it('random role+RPC combinations match expected authorization', () => {
      fc.assert(
        fc.property(roleArb, rpcFunctionArb, (role, rpcFn) => {
          const authorized = canCallRpc(role, rpcFn);

          // CS_User unauthorized for these:
          if (role === 'customer_service') {
            if (
              rpcFn === 'claim_ringcentral_intake' ||
              rpcFn === 'assign_customer_intake' ||
              rpcFn === 'resolve_quote_duplicate' ||
              rpcFn === 'merge_quote_records' ||
              rpcFn === 'delete_customer_intake' ||
              rpcFn === 'restore_customer_intake'
            ) {
              expect(authorized).toBe(false);
            }
            if (rpcFn === 'update_customer_intake') {
              expect(authorized).toBe(true);
            }
          }

          // Agent unauthorized for these:
          if (role === 'agent') {
            if (
              rpcFn === 'assign_customer_intake' ||
              rpcFn === 'delete_customer_intake' ||
              rpcFn === 'restore_customer_intake' ||
              rpcFn === 'resolve_quote_duplicate' ||
              rpcFn === 'merge_quote_records'
            ) {
              expect(authorized).toBe(false);
            }
            if (
              rpcFn === 'claim_ringcentral_intake' ||
              rpcFn === 'flag_quote_duplicate'
            ) {
              expect(authorized).toBe(true);
            }
          }

          // Manager authorized for everything:
          if (role === 'manager') {
            expect(authorized).toBe(true);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('random role+intake ownership combinations enforce correct SELECT visibility', () => {
      fc.assert(
        fc.property(roleArb, uuidArb, uuidArb, intakeStatusArb, (role, userId, ownerId, status) => {
          const intake: IntakeRow = { id: 'test-id', created_by: ownerId, status };
          const canSelect = canSelectIntake(role, userId, intake);

          switch (role) {
            case 'customer_service':
              // Can only see own intakes
              expect(canSelect).toBe(userId === ownerId);
              break;
            case 'agent':
              // Can see non-draft, non-deleted regardless of ownership
              expect(canSelect).toBe(status !== 'draft' && status !== 'deleted');
              break;
            case 'manager':
              // Can see everything
              expect(canSelect).toBe(true);
              break;
          }
        }),
        { numRuns: 100 }
      );
    });
  });
});
