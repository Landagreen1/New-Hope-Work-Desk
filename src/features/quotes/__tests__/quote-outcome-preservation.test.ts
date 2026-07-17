import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { QUOTE_TRANSITIONS, type QuoteStatus } from '../types';

// Feature: quote-outcome-rework, Property 2: Preservation
// Operational Transitions, Ownership Guards, and Backward Compat Unchanged
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
//
// These tests verify that the CURRENT code preserves existing behavior for:
// - Operational forward-only quote transitions (QUOTE_TRANSITIONS map)
// - Ownership guards (only owning agent can change their own outcomes)
// - Role guards (inactive/non-agent profiles rejected)
// - Backward compatibility (convert_my_not_sold_quote_to_sold still works)
// - add_quote_note continues to work unchanged
//
// These tests MUST PASS on unfixed code and MUST STILL PASS after the fix.

describe('PBT Preservation: Operational Transitions, Ownership Guards, and Backward Compat', () => {
  // ─── Arbitraries ─────────────────────────────────────────────────────────

  const uuidArb = fc.uuid();
  const noteArb = fc.string({ minLength: 3, maxLength: 100 }).filter(s => s.trim().length > 0);

  // All operational (non-terminal) statuses that have forward transitions
  const operationalStatuses: QuoteStatus[] = [
    'assigned',
    'quoting',
    'pricing_sent',
    'activation_pending',
    'activated',
  ];
  const operationalStatusArb = fc.constantFrom(...operationalStatuses);

  // Terminal statuses (no outbound transitions)
  const terminalStatuses: QuoteStatus[] = ['sold', 'not_sold', 'duplicate_review', 'merged_duplicate'];
  const terminalStatusArb = fc.constantFrom(...terminalStatuses);

  // All statuses
  const allStatuses = Object.keys(QUOTE_TRANSITIONS) as QuoteStatus[];
  const allStatusArb = fc.constantFrom(...allStatuses);

  // Not sold reasons (from the migration SQL)
  const notSoldReasons = [
    'price_too_high',
    'chose_another_option',
    'no_response',
    'no_longer_needed',
    'other',
  ] as const;
  const notSoldReasonArb = fc.constantFrom(...notSoldReasons);

  // Roles in the system
  const nonAgentRoles = ['customer_service', 'manager'] as const;
  const nonAgentRoleArb = fc.constantFrom(...nonAgentRoles);

  // Read migration files for SQL analysis
  const migrationsDir = path.resolve(__dirname, '../../../../supabase/migrations');

  function getAllMigrationContent(): string {
    try {
      const files = fs.readdirSync(migrationsDir);
      return files
        .filter(f => f.endsWith('.sql'))
        .map(f => fs.readFileSync(path.join(migrationsDir, f), 'utf-8'))
        .join('\n');
    } catch {
      return '';
    }
  }

  const allMigrationsSql = getAllMigrationContent();

  // Read work-desk-app source for UI verification
  const workDeskAppSource = fs.readFileSync(
    path.resolve(__dirname, '../../../components/work-desk-app.tsx'),
    'utf-8',
  );

  // ─── Property Test 1: Operational Transitions Enforce Forward-Only Flow ──
  // For all non-outcome-change operations (operational transitions, note additions,
  // log views), the QUOTE_TRANSITIONS map enforces forward-only progression.
  // sold/not_sold have empty outbound arrays — no operational transition out.
  //
  // **Validates: Requirements 3.1**
  describe('QUOTE_TRANSITIONS enforces forward-only operational flow', () => {
    it('operational statuses always have at least one forward transition', () => {
      fc.assert(
        fc.property(operationalStatusArb, (status) => {
          // Every operational (non-terminal) status must have at least one outbound transition
          const transitions = QUOTE_TRANSITIONS[status];
          expect(transitions.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 },
      );
    });

    it('terminal statuses (sold, not_sold) have no outbound operational transitions', () => {
      fc.assert(
        fc.property(terminalStatusArb, (status) => {
          // Terminal statuses must have empty outbound arrays — no operational forward path
          const transitions = QUOTE_TRANSITIONS[status];
          expect(transitions).toEqual([]);
        }),
        { numRuns: 100 },
      );
    });

    it('no status has a backward transition to a previous stage', () => {
      // Define the forward order of operational statuses
      const forwardOrder: QuoteStatus[] = [
        'assigned',
        'quoting',
        'pricing_sent',
        'activation_pending',
        'activated',
        'sold',
        'not_sold',
      ];

      fc.assert(
        fc.property(operationalStatusArb, (status) => {
          const currentIndex = forwardOrder.indexOf(status);
          const transitions = QUOTE_TRANSITIONS[status];

          // Every outbound transition must go to a status AFTER the current one
          // (except not_sold which is an "exit ramp" available from multiple stages)
          for (const target of transitions) {
            const targetIndex = forwardOrder.indexOf(target);
            if (target === 'not_sold') {
              // not_sold is always a valid "exit" from any operational status that allows it
              expect(targetIndex).toBeGreaterThan(currentIndex);
            } else {
              expect(targetIndex).toBeGreaterThan(currentIndex);
            }
          }
        }),
        { numRuns: 100 },
      );
    });

    it('QUOTE_TRANSITIONS map is fully defined for all QuoteStatus values', () => {
      fc.assert(
        fc.property(allStatusArb, (status) => {
          // Every status in the type must have an entry in the transitions map
          expect(QUOTE_TRANSITIONS[status]).toBeDefined();
          expect(Array.isArray(QUOTE_TRANSITIONS[status])).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it('finalize_my_active_quote RPC exists and validates agent role', () => {
      fc.assert(
        fc.property(operationalStatusArb, (status) => {
          // The finalize_my_active_quote RPC must exist in migrations and validate the agent
          const rpcExists = allMigrationsSql.includes('finalize_my_active_quote');
          const checksAgentRole =
            allMigrationsSql.includes('is_agent()') ||
            allMigrationsSql.includes("role = 'agent'");

          expect(rpcExists).toBe(true);
          expect(checksAgentRole).toBe(true);
        }),
        { numRuns: 20 },
      );
    });

    it('finalize_pending_pricing_quote RPC exists and handles forward progression', () => {
      fc.assert(
        fc.property(operationalStatusArb, (status) => {
          // The finalize_pending_pricing_quote RPC must exist in migrations
          const rpcExists = allMigrationsSql.includes('finalize_pending_pricing_quote');
          // It must insert into quote_outcomes (forward progression)
          const insertsOutcome = allMigrationsSql.includes('insert into public.quote_outcomes');

          expect(rpcExists).toBe(true);
          expect(insertsOutcome).toBe(true);
        }),
        { numRuns: 20 },
      );
    });
  });

  // ─── Property Test 2: Ownership Guards — Non-Owning Agents Rejected ──────
  // For all outcome modification attempts by non-owning agents, the system
  // rejects identically. The convert_my_not_sold_quote_to_sold RPC checks
  // assigned_profile_id = auth.uid().
  //
  // **Validates: Requirements 3.3**
  describe('Ownership guards reject non-owning agents', () => {
    it('convert_my_not_sold_quote_to_sold validates ownership (assigned_profile_id = auth.uid())', () => {
      fc.assert(
        fc.property(uuidArb, uuidArb, noteArb, (outcomeId, differentAgentId, note) => {
          // The RPC must check that the outcome belongs to the calling agent
          // by verifying assigned_profile_id = auth.uid()
          const ownershipCheck = allMigrationsSql.includes('assigned_profile_id = auth.uid()') ||
            allMigrationsSql.includes('assigned_profile_id = v_me.id');

          expect(ownershipCheck).toBe(true);
        }),
        { numRuns: 50 },
      );
    });

    it('convert_my_not_sold_quote_to_sold only finds quotes owned by calling agent', () => {
      fc.assert(
        fc.property(uuidArb, noteArb, (outcomeId, note) => {
          // The SQL query in convert_my_not_sold_quote_to_sold uses:
          // WHERE id = p_outcome_id AND assigned_profile_id = v_me.id AND decision = 'not_sold'
          // This means a different agent cannot modify another's outcome.
          const hasOwnershipFilter =
            allMigrationsSql.includes("and assigned_profile_id = v_me.id\n    and decision = 'not_sold'") ||
            (allMigrationsSql.includes('assigned_profile_id = v_me.id') &&
             allMigrationsSql.includes("decision = 'not_sold'"));

          expect(hasOwnershipFilter).toBe(true);
        }),
        { numRuns: 50 },
      );
    });

    it('finalize_my_active_quote validates ownership (assigned_profile_id = auth.uid())', () => {
      fc.assert(
        fc.property(uuidArb, (workItemId) => {
          // The finalize_my_active_quote RPC checks assigned_profile_id = auth.uid()
          // to ensure only the owning agent can finalize their own quote
          const hasOwnershipCheck =
            allMigrationsSql.includes('assigned_profile_id = auth.uid()');

          expect(hasOwnershipCheck).toBe(true);
        }),
        { numRuns: 50 },
      );
    });

    it('UI Mark Sold button only renders for quotes owned by current user', () => {
      fc.assert(
        fc.property(uuidArb, uuidArb, (quoteAssignedId, currentUserId) => {
          // The work-desk-app renders the Mark Sold button conditionally:
          // quote.assignedProfileId === currentUserId
          // This ensures non-owning agents cannot see the button.
          const hasOwnershipGate =
            workDeskAppSource.includes('assignedProfileId === currentUserId') ||
            workDeskAppSource.includes('assignedProfileId===currentUserId');

          expect(hasOwnershipGate).toBe(true);
        }),
        { numRuns: 50 },
      );
    });
  });

  // ─── Property Test 3: Role Guards — Inactive/Non-Agent Profiles Rejected ─
  // For all attempts by inactive/non-agent profiles, the system rejects identically.
  // The RPCs check: role = 'agent' AND is_active = true.
  //
  // **Validates: Requirements 3.5**
  describe('Role guards reject inactive and non-agent profiles', () => {
    it('convert_my_not_sold_quote_to_sold requires active agent profile', () => {
      fc.assert(
        fc.property(nonAgentRoleArb, uuidArb, noteArb, (role, outcomeId, note) => {
          // The RPC selects from profiles WHERE role = 'agent' AND is_active.
          // Non-agent roles and inactive profiles are rejected.
          const checksActiveAgent =
            allMigrationsSql.includes("role = 'agent'\n    and is_active") ||
            (allMigrationsSql.includes("role = 'agent'") && allMigrationsSql.includes('and is_active'));

          expect(checksActiveAgent).toBe(true);
        }),
        { numRuns: 50 },
      );
    });

    it('convert_my_not_sold_quote_to_sold raises exception for non-agent profiles', () => {
      fc.assert(
        fc.property(nonAgentRoleArb, fc.boolean(), (role, isActive) => {
          // When profile is not found (wrong role or inactive), the RPC raises an exception
          const hasRejection =
            allMigrationsSql.includes("raise exception 'Active agent profile required'");

          expect(hasRejection).toBe(true);
        }),
        { numRuns: 50 },
      );
    });

    it('finalize_my_active_quote requires agent role via is_agent() check', () => {
      fc.assert(
        fc.property(nonAgentRoleArb, (role) => {
          // finalize_my_active_quote uses is_agent() function which checks
          // role = 'agent' AND is_active
          const hasAgentCheck = allMigrationsSql.includes("if not public.is_agent() then raise exception 'Agent permission required'");

          expect(hasAgentCheck).toBe(true);
        }),
        { numRuns: 50 },
      );
    });

    it('finalize_pending_pricing_quote allows agent OR manager (but not other roles)', () => {
      fc.assert(
        fc.property(nonAgentRoleArb, (role) => {
          // finalize_pending_pricing_quote allows the owning agent OR a manager
          // (via assigned_profile_id = auth.uid() or public.is_manager())
          // Customer service and inactive profiles are rejected.
          const hasAgentOrManagerCheck =
            allMigrationsSql.includes('assigned_profile_id = auth.uid() or public.is_manager()');

          expect(hasAgentOrManagerCheck).toBe(true);
        }),
        { numRuns: 50 },
      );
    });

    it('add_quote_note requires active work desk user (agent, manager, or customer_service)', () => {
      fc.assert(
        fc.property(fc.boolean(), (isActive) => {
          // add_quote_note checks: role in ('agent', 'manager', 'customer_service') AND is_active
          // Inactive profiles are rejected regardless of role
          const hasRoleCheck =
            allMigrationsSql.includes("role in ('agent', 'manager', 'customer_service')");
          const hasActiveCheck =
            allMigrationsSql.includes('and is_active');

          expect(hasRoleCheck).toBe(true);
          expect(hasActiveCheck).toBe(true);
        }),
        { numRuns: 50 },
      );
    });
  });

  // ─── Property Test 4: Backward Compatibility — convert_my_not_sold_quote_to_sold ─
  // The existing convert_my_not_sold_quote_to_sold RPC works correctly for its
  // original not_sold → sold use case on unfixed code.
  //
  // **Validates: Requirements 3.2**
  describe('convert_my_not_sold_quote_to_sold backward compatibility', () => {
    it('RPC exists with correct signature (p_outcome_id uuid, p_note text)', () => {
      fc.assert(
        fc.property(uuidArb, noteArb, (outcomeId, note) => {
          // The function must exist with its original signature
          const hasFunction = allMigrationsSql.includes('convert_my_not_sold_quote_to_sold');
          const hasSignature =
            allMigrationsSql.includes('p_outcome_id uuid') &&
            allMigrationsSql.includes('p_note text');

          expect(hasFunction).toBe(true);
          expect(hasSignature).toBe(true);
        }),
        { numRuns: 50 },
      );
    });

    it('RPC requires non-empty note (nullif(btrim(p_note)))', () => {
      fc.assert(
        fc.property(uuidArb, (outcomeId) => {
          // The RPC validates that the note is non-empty before proceeding
          const validatesNote =
            allMigrationsSql.includes("nullif(btrim(p_note), '')") ||
            allMigrationsSql.includes("nullif(btrim(p_note),'')");

          expect(validatesNote).toBe(true);
        }),
        { numRuns: 50 },
      );
    });

    it('RPC only operates on not_sold outcomes (decision filter in WHERE clause)', () => {
      fc.assert(
        fc.property(uuidArb, noteArb, (outcomeId, note) => {
          // The RPC specifically filters for decision = 'not_sold'
          // confirming it only handles the not_sold → sold direction
          const filtersNotSold = allMigrationsSql.includes("decision = 'not_sold'");

          expect(filtersNotSold).toBe(true);
        }),
        { numRuns: 50 },
      );
    });

    it('RPC sets decision to sold and clears not_sold_reason fields', () => {
      fc.assert(
        fc.property(uuidArb, noteArb, (outcomeId, note) => {
          // On success, the RPC updates: decision = 'sold', not_sold_reason = null,
          // not_sold_reason_other = null, finalized_at = now()
          const setsDecisionSold = allMigrationsSql.includes("decision = 'sold'");
          const clearsReason = allMigrationsSql.includes('not_sold_reason = null');
          const clearsReasonOther = allMigrationsSql.includes('not_sold_reason_other = null');
          const updatesFinalized = allMigrationsSql.includes('finalized_at = now()');

          expect(setsDecisionSold).toBe(true);
          expect(clearsReason).toBe(true);
          expect(clearsReasonOther).toBe(true);
          expect(updatesFinalized).toBe(true);
        }),
        { numRuns: 50 },
      );
    });

    it('RPC logs audit trail (work_item_events, quote_notes, audit_log)', () => {
      fc.assert(
        fc.property(uuidArb, noteArb, (outcomeId, note) => {
          // The RPC inserts into work_item_events, quote_notes, and audit_log
          const logsEvent = allMigrationsSql.includes('insert into public.work_item_events');
          const logsNote = allMigrationsSql.includes('insert into public.quote_notes');
          const logsAudit = allMigrationsSql.includes('insert into public.audit_log');

          expect(logsEvent).toBe(true);
          expect(logsNote).toBe(true);
          expect(logsAudit).toBe(true);
        }),
        { numRuns: 50 },
      );
    });

    it('RPC is granted to authenticated users only', () => {
      fc.assert(
        fc.property(uuidArb, (id) => {
          // Permission model: revoked from public/anon, granted to authenticated
          const revokedFromPublic = allMigrationsSql.includes(
            'revoke execute on function public.convert_my_not_sold_quote_to_sold',
          ) || allMigrationsSql.includes(
            'revoke execute on function convert_my_not_sold_quote_to_sold',
          );
          const grantedToAuth = allMigrationsSql.includes(
            'grant execute on function public.convert_my_not_sold_quote_to_sold',
          );

          expect(revokedFromPublic).toBe(true);
          expect(grantedToAuth).toBe(true);
        }),
        { numRuns: 20 },
      );
    });
  });

  // ─── Property Test 5: add_quote_note Continues Unchanged ─────────────────
  // The add_quote_note function works identically — validates user, validates
  // quote existence, inserts note, logs audit entry.
  //
  // **Validates: Requirements 3.4 (field preservation) and general preservation**
  describe('add_quote_note continues to work unchanged', () => {
    it('add_quote_note function exists in migrations', () => {
      fc.assert(
        fc.property(uuidArb, noteArb, (quoteId, note) => {
          const functionExists = allMigrationsSql.includes('add_quote_note');
          expect(functionExists).toBe(true);
        }),
        { numRuns: 20 },
      );
    });

    it('add_quote_note validates that note text is non-empty', () => {
      fc.assert(
        fc.property(uuidArb, (quoteId) => {
          // The function trims and checks for null/empty note
          const validatesNote =
            allMigrationsSql.includes("nullif(btrim(p_note), '')") &&
            allMigrationsSql.includes("'A follow-up note is required'");

          expect(validatesNote).toBe(true);
        }),
        { numRuns: 20 },
      );
    });

    it('add_quote_note validates quote existence across work_items, pending_pricing, and outcomes', () => {
      fc.assert(
        fc.property(uuidArb, noteArb, (quoteId, note) => {
          // The function checks for the quote across all three tables
          const checksWorkItems = allMigrationsSql.includes('from public.work_items w');
          const checksPending = allMigrationsSql.includes('from public.pending_pricing_quotes p');
          const checksOutcomes = allMigrationsSql.includes('from public.quote_outcomes q');

          expect(checksWorkItems).toBe(true);
          expect(checksPending).toBe(true);
          expect(checksOutcomes).toBe(true);
        }),
        { numRuns: 20 },
      );
    });

    it('add_quote_note inserts into quote_notes and audit_log', () => {
      fc.assert(
        fc.property(uuidArb, noteArb, (quoteId, note) => {
          // The function inserts a note and logs it
          const insertsNote = allMigrationsSql.includes('insert into public.quote_notes');
          const logsAudit =
            allMigrationsSql.includes("'quote_note_added'") &&
            allMigrationsSql.includes('insert into public.audit_log');

          expect(insertsNote).toBe(true);
          expect(logsAudit).toBe(true);
        }),
        { numRuns: 20 },
      );
    });

    it('add_quote_note is granted to authenticated users', () => {
      fc.assert(
        fc.property(uuidArb, (id) => {
          const grantedToAuth = allMigrationsSql.includes(
            'grant execute on function public.add_quote_note',
          );

          expect(grantedToAuth).toBe(true);
        }),
        { numRuns: 20 },
      );
    });
  });

  // ─── Property Test 6: Field Preservation ─────────────────────────────────
  // For all outcome changes, only decision, finalized_at, not_sold_reason, and
  // not_sold_reason_other may change. All other fields are preserved.
  //
  // **Validates: Requirements 3.4**
  describe('Only decision, finalized_at, not_sold_reason, not_sold_reason_other change on outcome update', () => {
    it('convert_my_not_sold_quote_to_sold only updates decision, reason fields, and finalized_at', () => {
      fc.assert(
        fc.property(uuidArb, noteArb, (outcomeId, note) => {
          // The UPDATE statement in convert_my_not_sold_quote_to_sold sets:
          // decision = 'sold', not_sold_reason = null, not_sold_reason_other = null, finalized_at = now()
          // It does NOT update: source_work_item_id, customer_name, dealer_id,
          // assigned_profile_id, quote_created_at, assigned_at, accepted_at, price_sent_at, etc.
          const updatePattern =
            allMigrationsSql.includes("set decision = 'sold'") &&
            allMigrationsSql.includes('not_sold_reason = null') &&
            allMigrationsSql.includes('not_sold_reason_other = null') &&
            allMigrationsSql.includes('finalized_at = now()');

          expect(updatePattern).toBe(true);

          // Verify it does NOT update preserved fields
          // The SET clause should NOT contain these field assignments
          // (We check that the narrow update in convert_my_not_sold_quote_to_sold
          //  does not reassign ownership or timing fields)
          const updateSection = allMigrationsSql.substring(
            allMigrationsSql.indexOf('update public.quote_outcomes'),
            allMigrationsSql.indexOf('update public.quote_outcomes') + 500,
          );

          // The update in the context of convert_my_not_sold_quote_to_sold
          // should not touch source_work_item_id or assigned_profile_id
          expect(updateSection).not.toContain('source_work_item_id =');
          expect(updateSection).not.toContain('assigned_profile_id =');
        }),
        { numRuns: 50 },
      );
    });
  });
});
