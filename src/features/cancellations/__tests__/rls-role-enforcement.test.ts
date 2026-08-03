//
// Feature: policy-follow-up-renewals-cancellations, task 17.1 — role enforcement.
//
// **Validates: Requirements 19.11, 22.1, 22.2, 22.3, 22.6, 22.9, 22.10, 22.12, 25.2**
//
// ---------------------------------------------------------------------------------------------
// THE STRATEGY, AND WHY IT IS TWO HALVES
// ---------------------------------------------------------------------------------------------
// This file runs in the default `npm test` suite, so it must decide every question offline: no
// Supabase project, no service key, no network. Requirement 22.9 puts the same rules in two
// places — "database row level security policies AND server-side authorization checks" — and each
// half is asserted the only way it can be asserted without a live session:
//
//   PART A — THE AUTHORIZATION SURFACE THE CLIENT REACHES FIRST.
//   `src/features/cancellations/api.ts` fails closed with a readable message *before* every gated
//   write (`requireActor`, `requireManager`), because a row level security refusal on a read comes
//   back as zero rows rather than as an error and the surface has to be able to say why
//   (Requirement 22.6). `src/features/cancellations/derive.ts` owns the read scope
//   (`canReadCancellationCase`), and `src/features/cancellations/scheduler/manual-send.ts` owns the
//   only refusal in the feature that carries a literal HTTP status. All three are driven here over
//   every role in `APP_ROLES` — the real `canAccessRenewals` and `isBroadManagerRole` from
//   `@/lib/permissions` decide which role is which, never a role list written in this file, so a
//   role added to the application is a role this suite immediately covers.
//
//   PART B — THE POLICY PREDICATES AS WRITTEN.
//   The 38 policies of `supabase/migrations/v1.10.6-cancellation-rls.sql` are the enforcement, and
//   a claim about them is a claim about that file's text. So the migration is parsed — comments
//   stripped, `create policy` statements read out with their `using` and `with check` predicates —
//   and the structural properties Requirement 22 fixes are asserted policy by policy: every
//   cancellation table protected, every role decision delegated to
//   `public.cancellation_is_manager()` / `public.cancellation_can_read_all()` (whose own
//   definitions in `v1.10.0` name `super_admin` beside `manager`, which is what makes
//   "`super_admin` matches `manager` on every check" a checkable statement rather than a hope), no
//   insert path into `cancellation_verification_outcomes` outside Manager_Role, no policy on
//   `cancellation_import_runs` that admits `agent`, and no update or delete policy at all on
//   `cancellation_communications` or `cancellation_events`.
//
// Every scan asserts that it found what it claims to check: the policy count, the sixteen tables,
// the predicate of each named policy. A text scan that matched nothing would otherwise pass every
// prohibition in this file without proving anything.
//
// ---------------------------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT ASSERTED HERE, AND WHERE IT LIVES
// ---------------------------------------------------------------------------------------------
// One thing this file cannot do: run a real session as each role and watch Postgres refuse it.
// A policy's text is not its behaviour, and no amount of parsing proves that `authenticated`
// carries the grants the policies sit on. That proof exists in two places, neither of them here:
//
//   * `v1.10.6` section 5b performs it at apply time — it inserts probe rows, `set local role
//     authenticated`, sets `request.jwt.claims` per role, attempts each read and write, and rolls
//     the whole migration back if any outcome is wrong. That is a live per-role enforcement proof
//     that runs before the policies are ever deployed.
//   * The integration suite is its home in the test tree: task 17.2's
//     `audit-immutability.integration.test.ts`, run by `npm run test:integration` against the live
//     project and self-skipping without credentials. A live per-role RLS probe belongs beside it,
//     not in this file, which is why every assertion below is either behaviour of shipped
//     TypeScript or a property of the migration's text.
//
// Also not here: `overrideCaseStatus` treats every non-Manager_Role role alike — it is the
// manager-or-not gate — so a role outside the Policy Follow-up workspace entirely is refused by
// the workspace gate rather than by that function. That gate is `roleMayUseManualSend`
// (`canAccessRenewals`), and it is driven below with the 403 it answers.

import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { APP_ROLES, canAccessRenewals, isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import { CASE_STATUSES } from '../domain/communication-status';
import { canReadCancellationCase } from '../derive';
import {
  CASE_NOT_ASSIGNED_MESSAGE,
  RETRY_REQUIRES_MANAGER_MESSAGE,
  ROLE_NOT_PERMITTED_MESSAGE,
  runManualSend,
  type ManualSendActor,
} from '../scheduler/manual-send';

// ---------------------------------------------------------------------------
// The Supabase double behind `api.ts`
//
// `api.ts` is a `'use client'` module that reaches the shared cookie-aware browser client. It is
// replaced here by a recorder: reads answer from a seeded state, writes are recorded and never
// filtered, and storage and RPC raise. Nothing here re-implements row level security — a write
// this double accepts is a write the *client-side* gate allowed through, which is exactly the
// thing under test, and the policies of Part B are what would stop it in the database.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const db = vi.hoisted(() => {
  interface State {
    actor: Row | null;
    caseRow: Row | null;
    contacts: Record<string, unknown>[];
    suppressions: Record<string, unknown>[];
    settings: Record<string, unknown>;
  }

  const state: State = { actor: null, caseRow: null, contacts: [], suppressions: [], settings: {} };
  /** Tables read, in order. Empty means a refusal happened before any data was touched. */
  const reads: string[] = [];
  /** Every insert and update the gates let through. A refusal must leave this empty. */
  const writes: { table: string; operation: 'insert' | 'update'; payload: Record<string, unknown> }[] = [];
  /** Storage and RPC traffic, which no test here expects. */
  const storage: string[] = [];
  const rpcs: string[] = [];

  let sequence = 0;

  const reset = (): void => {
    state.actor = null;
    state.caseRow = null;
    state.contacts = [];
    state.suppressions = [];
    state.settings = {
      automatic_sending_enabled: true,
      office_phone: '(704) 824-3130',
      agency_name: 'New Hope Insurance Agency',
      bilingual_separator: '\n---\n',
      holidays: [],
      updated_by: null,
      updated_at: '2026-07-16T14:00:00.000Z',
    };
    reads.length = 0;
    writes.length = 0;
    storage.length = 0;
    rpcs.length = 0;
    sequence = 0;
  };

  reset();

  const selectRows = (table: string): Record<string, unknown>[] => {
    switch (table) {
      case 'profiles':
        return state.actor === null ? [] : [state.actor];
      case 'cancellation_cases':
        return state.caseRow === null ? [] : [state.caseRow];
      case 'cancellation_contacts':
        return state.contacts;
      case 'cancellation_suppressions':
        return state.suppressions;
      case 'cancellation_settings':
        return [state.settings];
      default:
        return [];
    }
  };

  const mutableRow = (table: string): Record<string, unknown> | null => {
    if (table === 'cancellation_cases') return state.caseRow;
    if (table === 'cancellation_settings') return state.settings;
    return null;
  };

  interface Outcome {
    data: unknown;
    error: { code?: string; message: string } | null;
  }

  const builder = (
    table: string,
    operation: 'select' | 'insert' | 'update',
    payload: Record<string, unknown> | readonly Record<string, unknown>[] | null,
  ) => {
    let outcome: Outcome | null = null;

    const execute = (): Outcome => {
      if (outcome !== null) return outcome;

      if (operation === 'select') {
        reads.push(table);
        outcome = { data: selectRows(table).map((row) => ({ ...row })), error: null };
        return outcome;
      }

      const incoming = Array.isArray(payload)
        ? (payload as Record<string, unknown>[])
        : [(payload ?? {}) as Record<string, unknown>];
      const stored: Record<string, unknown>[] = [];

      for (const row of incoming) {
        writes.push({ table, operation, payload: { ...row } });
        if (operation === 'insert') {
          sequence += 1;
          stored.push({ id: `${table}-${sequence}`, ...row });
          continue;
        }
        const base = mutableRow(table);
        if (base === null) {
          stored.push({ ...row });
          continue;
        }
        Object.assign(base, row);
        stored.push({ ...base });
      }

      outcome = { data: stored, error: null };
      return outcome;
    };

    const self = {
      select: () => self,
      eq: () => self,
      in: () => self,
      is: () => self,
      not: () => self,
      gte: () => self,
      lte: () => self,
      order: () => self,
      limit: () => self,
      range: () => self,
      single: async (): Promise<Outcome> => {
        const result = execute();
        const rows = (result.data as Record<string, unknown>[]) ?? [];
        if (rows.length === 0) {
          return { data: null, error: { code: 'PGRST116', message: 'no rows returned' } };
        }
        return { data: rows[0], error: null };
      },
      maybeSingle: async (): Promise<Outcome> => {
        const result = execute();
        const rows = (result.data as Record<string, unknown>[]) ?? [];
        return { data: rows[0] ?? null, error: null };
      },
      then: <TResult>(
        onFulfilled: (value: Outcome) => TResult,
        onRejected?: (reason: unknown) => TResult,
      ): Promise<TResult> => Promise.resolve(execute()).then(onFulfilled, onRejected),
    };

    return self;
  };

  const client = {
    auth: {
      getUser: async () =>
        state.actor === null
          ? { data: { user: null }, error: null }
          : { data: { user: { id: state.actor.id as string } }, error: null },
    },
    from(table: string) {
      return {
        select: () => builder(table, 'select', null),
        insert: (payload: Record<string, unknown> | readonly Record<string, unknown>[]) =>
          builder(table, 'insert', payload),
        update: (payload: Record<string, unknown>) => builder(table, 'update', payload),
      };
    },
    storage: {
      from(bucket: string) {
        const record = (operation: string) => {
          storage.push(`${bucket}.${operation}`);
          return { data: null, error: { message: 'storage is not available in this suite' } };
        };
        return {
          upload: async () => record('upload'),
          remove: async () => record('remove'),
          createSignedUrl: async () => record('createSignedUrl'),
          download: async () => record('download'),
        };
      },
    },
    async rpc(name: string): Promise<Outcome> {
      rpcs.push(name);
      return { data: null, error: null };
    },
  };

  return { state, reads, writes, storage, rpcs, reset, client };
});

vi.mock('../../nhwd-shared/client', () => ({
  getSupabase: () => db.client,
}));

// `api.ts` is imported after the mock is registered, so `getSupabase` inside it is the double.
import {
  AGENT_SETTABLE_CASE_STATUSES,
  TERMINAL_CASE_STATUSES,
  assignCancellationCase,
  clearContactOptOut,
  getCancellationActor,
  overrideCaseStatus,
  recordVerificationOutcome,
  setAutomaticSendingEnabled,
} from '../api';

// ---------------------------------------------------------------------------
// Roles, taken from the application rather than restated
// ---------------------------------------------------------------------------

/** Every role that reaches the Policy Follow-up workspace at all (Requirement 22.5, 22.12). */
const WORKSPACE_ROLES: AppRole[] = APP_ROLES.filter((role) => canAccessRenewals(role));
/** `manager` and `super_admin`, which hold every Manager_Role permission. */
const MANAGER_ROLES: AppRole[] = WORKSPACE_ROLES.filter((role) => isBroadManagerRole(role));
/** `agent`, `customer_service`, `sales_supervisor` — Agent_Role in Requirement 22.5's sense. */
const AGENT_ROLES: AppRole[] = WORKSPACE_ROLES.filter((role) => !isBroadManagerRole(role));
/** Roles with no access to the workspace, which every check must refuse outright. */
const OUTSIDE_ROLES: AppRole[] = APP_ROLES.filter((role) => !canAccessRenewals(role));

const SELF = 'profile-self';
const OTHER = 'profile-other';
const CASE_ID = 'case-1';

function actorRow(role: AppRole, id = SELF): Row {
  return { id, display_name: `Test ${role}`, role };
}

function caseRow(overrides: Row = {}): Row {
  return {
    id: CASE_ID,
    policy_number: 'POL-10001',
    policy_number_normalized: 'POL10001',
    cancellation_effective_date: '2026-07-31',
    customer_name: 'Rosa Martinez',
    client_identifier: '0091',
    customer_match_key: 'client-9001',
    carrier: 'Progressive',
    cancellation_reason: 'Non-payment',
    amount_due: '1234.50',
    case_status: 'Open',
    communication_status: 'Scheduled',
    next_required_action: 'Send Reminder Now',
    assigned_to: SELF,
    assignment_source: 'import',
    producer_label: 'MG - Maria Gomez',
    follow_up_deadline: null,
    assistance_requested: false,
    import_run_id: 'run-1',
    source_row_number: 2,
    created_at: '2026-07-01T12:00:00.000Z',
    updated_at: '2026-07-01T12:00:00.000Z',
    ...overrides,
  };
}

/** Signs the given role in and seeds one case, so a gated write has something to aim at. */
function signIn(role: AppRole, caseOverrides: Row = {}): void {
  db.reset();
  db.state.actor = actorRow(role);
  db.state.caseRow = caseRow(caseOverrides);
}

/** The message a refused call threw, or `null` where the call was allowed through. */
async function refusal(action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action();
    return null;
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
}

/** Every recorder that must be empty after a refusal (Requirements 19.11, 22.6, 22.11). */
function expectNothingWritten(): void {
  expect(db.writes, 'a refused operation wrote rows').toEqual([]);
  expect(db.storage, 'a refused operation uploaded evidence').toEqual([]);
  expect(db.rpcs, 'a refused operation called a database function').toEqual([]);
}

beforeEach(() => {
  db.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
// PART A — the authorization surface the client reaches first
// ═══════════════════════════════════════════════════════════════════════════

describe('the role sets under test are the application\'s own', () => {
  it('resolves the five Policy Follow-up roles from canAccessRenewals', () => {
    // The task names five roles. They are not written down here: they are whatever
    // `canAccessRenewals` admits, so this assertion is what ties the two together.
    expect([...WORKSPACE_ROLES].sort()).toEqual([
      'agent',
      'customer_service',
      'manager',
      'sales_supervisor',
      'super_admin',
    ]);
    expect([...MANAGER_ROLES].sort()).toEqual(['manager', 'super_admin']);
    expect([...AGENT_ROLES].sort()).toEqual(['agent', 'customer_service', 'sales_supervisor']);
  });

  it('has at least one role outside the workspace to refuse', () => {
    // Without this, every "a role outside the workspace is refused" case below would be vacuous.
    expect(OUTSIDE_ROLES.length).toBeGreaterThan(0);
    for (const role of OUTSIDE_ROLES) expect(isBroadManagerRole(role)).toBe(false);
  });
});

describe('case read scope (Requirements 22.1, 22.3, 22.12)', () => {
  const OWN = { assigned_to: SELF };
  const UNASSIGNED = { assigned_to: null };
  const SOMEBODY_ELSE = { assigned_to: OTHER };

  it('gives agent its own cases and the unassigned ones, and every other workspace role all three', () => {
    for (const role of WORKSPACE_ROLES) {
      const viewer = { role, profileId: SELF };
      expect(canReadCancellationCase(viewer, OWN), `${role} own case`).toBe(true);
      expect(canReadCancellationCase(viewer, UNASSIGNED), `${role} unassigned case`).toBe(true);
      expect(canReadCancellationCase(viewer, SOMEBODY_ELSE), `${role} another profile's case`).toBe(
        role !== 'agent',
      );
    }
  });

  it('gives a role outside the workspace nothing at all', () => {
    for (const role of OUTSIDE_ROLES) {
      const viewer = { role, profileId: SELF };
      for (const row of [OWN, UNASSIGNED, SOMEBODY_ELSE]) {
        expect(canReadCancellationCase(viewer, row), `${role} ${String(row.assigned_to)}`).toBe(false);
      }
    }
  });

  it('answers identically for super_admin and manager on every case shape', () => {
    for (const row of [OWN, UNASSIGNED, SOMEBODY_ELSE]) {
      const asManager = canReadCancellationCase({ role: 'manager', profileId: SELF }, row);
      const asSuperAdmin = canReadCancellationCase({ role: 'super_admin', profileId: SELF }, row);
      expect(asSuperAdmin, `super_admin diverged from manager on ${String(row.assigned_to)}`).toBe(
        asManager,
      );
      expect(asManager).toBe(true);
    }
  });
});

describe('the Case_Status values an Agent_Role profile may set (Requirements 22.10, 22.11)', () => {
  const REASON = 'Customer called to confirm the payment was posted.';

  it('names four settable values and five terminal values, all of them real statuses', () => {
    expect([...AGENT_SETTABLE_CASE_STATUSES]).toEqual([
      'Open',
      'Payment Reported',
      'Verification Pending',
      'Reinstatement Pending',
    ]);
    expect([...TERMINAL_CASE_STATUSES]).toEqual([
      'Reinstated',
      'Cancelled',
      'Resolved',
      'Invalid',
      'Duplicate',
    ]);
    for (const status of [...AGENT_SETTABLE_CASE_STATUSES, ...TERMINAL_CASE_STATUSES]) {
      expect(CASE_STATUSES).toContain(status);
    }
    // `Imported` is in neither set: an Agent_Role profile may hold a case at it but may not set it.
    expect([...AGENT_SETTABLE_CASE_STATUSES, ...TERMINAL_CASE_STATUSES]).not.toContain('Imported');
  });

  it('accepts exactly the four values from an Agent_Role profile on an open case', async () => {
    for (const role of AGENT_ROLES) {
      for (const status of CASE_STATUSES) {
        signIn(role, { case_status: 'Open' });
        const message = await refusal(() =>
          overrideCaseStatus({ caseId: CASE_ID, caseStatus: status, reason: REASON }),
        );
        const permitted = (AGENT_SETTABLE_CASE_STATUSES as readonly string[]).includes(status);

        if (permitted) {
          expect(message, `${role} was refused the permitted status ${status}`).toBeNull();
          expect(db.writes.filter((write) => write.table === 'cancellation_cases')).toHaveLength(1);
          continue;
        }

        expect(message, `${role} was allowed to set ${status}`).toMatch(/manager or super admin/i);
        expectNothingWritten();
      }
    }
  });

  it('accepts every value from manager and from super_admin alike', async () => {
    for (const role of MANAGER_ROLES) {
      for (const status of CASE_STATUSES) {
        signIn(role, { case_status: 'Open' });
        const message = await refusal(() =>
          overrideCaseStatus({ caseId: CASE_ID, caseStatus: status, reason: REASON }),
        );
        expect(message, `${role} was refused ${status}`).toBeNull();

        const update = db.writes.find(
          (write) => write.table === 'cancellation_cases' && write.operation === 'update',
        );
        expect(update?.payload.case_status).toBe(status);
      }
    }
  });

  it('refuses an Agent_Role profile every change on a closed case, the four values included', async () => {
    for (const role of AGENT_ROLES) {
      for (const stored of TERMINAL_CASE_STATUSES) {
        for (const status of AGENT_SETTABLE_CASE_STATUSES) {
          signIn(role, { case_status: stored });
          const message = await refusal(() =>
            overrideCaseStatus({ caseId: CASE_ID, caseStatus: status, reason: REASON }),
          );
          expect(message, `${role} changed a ${stored} case to ${status}`).toMatch(
            /manager or super admin/i,
          );
          expect(message).toContain(stored);
          expectNothingWritten();
        }
      }
    }
  });

  it('lets manager and super_admin change a closed case', async () => {
    for (const role of MANAGER_ROLES) {
      signIn(role, { case_status: 'Cancelled' });
      const message = await refusal(() =>
        overrideCaseStatus({ caseId: CASE_ID, caseStatus: 'Resolved', reason: REASON }),
      );
      expect(message, `${role} was refused a change on a closed case`).toBeNull();
    }
  });

  it('refuses reason text outside 1 to 1,000 characters from every role, status unchanged', async () => {
    for (const role of WORKSPACE_ROLES) {
      for (const reason of ['', '   ', 'x'.repeat(1001)]) {
        signIn(role, { case_status: 'Open' });
        const message = await refusal(() =>
          overrideCaseStatus({ caseId: CASE_ID, caseStatus: 'Open', reason }),
        );
        expect(message, `${role} overrode a status with ${reason.length} characters of reason`).toMatch(
          /1 to 1000 characters/i,
        );
        expectNothingWritten();
      }
    }
  });
});

describe('payment verification outcomes are Manager_Role only (Requirement 19.11)', () => {
  it('refuses every Agent_Role profile with nothing written and nothing uploaded', async () => {
    for (const role of AGENT_ROLES) {
      signIn(role, { case_status: 'Payment Reported', next_required_action: 'Verify Payment' });
      const message = await refusal(() =>
        recordVerificationOutcome({
          caseId: CASE_ID,
          outcome: 'Policy reinstated',
          nextCaseStatus: 'Reinstated',
          nextRequiredAction: null,
        }),
      );

      expect(message, `${role} recorded a verification outcome`).toMatch(/manager or super admin/i);
      expectNothingWritten();
      // Requirement 19.11: Case_Status and the next required action are both left as stored.
      expect(db.state.caseRow?.case_status).toBe('Payment Reported');
      expect(db.state.caseRow?.next_required_action).toBe('Verify Payment');
    }
  });

  it('refuses a role outside the workspace as well', async () => {
    for (const role of OUTSIDE_ROLES) {
      signIn(role, { case_status: 'Payment Reported' });
      const message = await refusal(() =>
        recordVerificationOutcome({ caseId: CASE_ID, outcome: 'Payment not found' }),
      );
      expect(message, `${role} recorded a verification outcome`).toMatch(/manager or super admin/i);
      expectNothingWritten();
    }
  });

  it('accepts manager and super_admin identically, storing the recording profile', async () => {
    for (const role of MANAGER_ROLES) {
      signIn(role, { case_status: 'Payment Reported', next_required_action: 'Verify Payment' });
      const message = await refusal(() =>
        recordVerificationOutcome({
          caseId: CASE_ID,
          outcome: 'Policy reinstated',
          nextCaseStatus: 'Reinstated',
          nextRequiredAction: null,
        }),
      );

      expect(message, `${role} was refused a verification outcome`).toBeNull();
      const insert = db.writes.find(
        (write) => write.table === 'cancellation_verification_outcomes' && write.operation === 'insert',
      );
      expect(insert?.payload.recorded_by).toBe(SELF);
      expect(insert?.payload.outcome).toBe('Policy reinstated');
      expect(db.state.caseRow?.case_status).toBe('Reinstated');
    }
  });
});

describe('the other Manager_Role operations (Requirements 22.3, 22.6)', () => {
  it('refuses reassignment outside Manager_Role and leaves the assignment as stored', async () => {
    for (const role of [...AGENT_ROLES, ...OUTSIDE_ROLES]) {
      signIn(role);
      const message = await refusal(() => assignCancellationCase(CASE_ID, OTHER));
      expect(message, `${role} reassigned a cancellation`).toMatch(/manager or super admin/i);
      expectNothingWritten();
      expect(db.state.caseRow?.assigned_to).toBe(SELF);
    }
  });

  it('refuses the automatic sending switch outside Manager_Role and leaves it as stored', async () => {
    for (const role of [...AGENT_ROLES, ...OUTSIDE_ROLES]) {
      signIn(role);
      const message = await refusal(() => setAutomaticSendingEnabled(false));
      expect(message, `${role} changed the automatic sending setting`).toMatch(
        /manager or super admin/i,
      );
      expectNothingWritten();
      expect(db.state.settings.automatic_sending_enabled).toBe(true);
    }
  });

  it('refuses clearing an opt-out outside Manager_Role before any row is read', async () => {
    for (const role of [...AGENT_ROLES, ...OUTSIDE_ROLES]) {
      signIn(role);
      const message = await refusal(() =>
        clearContactOptOut({
          channel: 'sms',
          normalizedValue: '+17045551234',
          reason: 'The customer called and asked for the texts again.',
        }),
      );
      expect(message, `${role} cleared an opt-out`).toMatch(/manager or super admin/i);
      // Requirement 22.6's "leave every stored value unchanged", at its strongest: the only read
      // that happened is the actor's own profile, so no cancellation row was even looked at.
      expect(db.reads).toEqual(['profiles']);
      expectNothingWritten();
    }
  });

  it('lets manager and super_admin through each of the three gates', async () => {
    for (const role of MANAGER_ROLES) {
      signIn(role);
      expect(await refusal(() => assignCancellationCase(CASE_ID, OTHER)), role).toBeNull();
      expect(db.state.caseRow?.assigned_to).toBe(OTHER);
      expect(db.state.caseRow?.assignment_source).toBe('manager');

      signIn(role);
      expect(await refusal(() => setAutomaticSendingEnabled(false)), role).toBeNull();
      expect(db.state.settings.automatic_sending_enabled).toBe(false);
      expect(db.state.settings.updated_by).toBe(SELF);

      signIn(role);
      const clearMessage = await refusal(() =>
        clearContactOptOut({
          channel: 'sms',
          normalizedValue: '+17045551234',
          reason: 'The customer called and asked for the texts again.',
        }),
      );
      // Whatever the plan then decided about a value with no stored suppression, it was not a role
      // refusal, and the contact read is what proves the Manager_Role gate was passed.
      if (clearMessage !== null) {
        expect(clearMessage, role).not.toMatch(/manager or super admin/i);
      }
      expect(db.reads, role).toContain('cancellation_contacts');
    }
  });

  it('refuses every gated write when there is no session at all', async () => {
    db.reset();
    db.state.caseRow = caseRow();
    expect(await getCancellationActor()).toBeNull();

    for (const action of [
      () => assignCancellationCase(CASE_ID, OTHER),
      () => setAutomaticSendingEnabled(false),
      () => recordVerificationOutcome({ caseId: CASE_ID, outcome: 'Policy reinstated' }),
      () => overrideCaseStatus({ caseId: CASE_ID, caseStatus: 'Open', reason: 'No session.' }),
    ]) {
      const message = await refusal(action);
      expect(message).toMatch(/session expired/i);
    }
    expectNothingWritten();
  });
});

// ---------------------------------------------------------------------------
// The two send actions, which are the one place a refusal carries an HTTP status
// ---------------------------------------------------------------------------

describe('manual send authorization returns 403 and writes nothing (Requirements 22.2, 22.6, 22.12)', () => {
  /** Reads answer from the seed; a write or a provider call fails the test by throwing. */
  function sendClient(seed: { caseRow: Row | null; settings: Row | null }) {
    const touched: string[] = [];
    const written: string[] = [];

    const rows = (table: string): Row[] => {
      if (table === 'cancellation_cases') return seed.caseRow === null ? [] : [seed.caseRow];
      if (table === 'cancellation_settings') return seed.settings === null ? [] : [seed.settings];
      return [];
    };

    const thenable = (table: string) => {
      const self = {
        select: () => self,
        in: () => self,
        is: () => self,
        eq: () => self,
        order: () => self,
        then: <TResult>(
          onFulfilled: (value: { data: unknown; error: null }) => TResult,
          onRejected?: (reason: unknown) => TResult,
        ): Promise<TResult> => {
          touched.push(table);
          return Promise.resolve({ data: rows(table).map((row) => ({ ...row })), error: null }).then(
            onFulfilled,
            onRejected,
          );
        },
      };
      return self;
    };

    const client = {
      from(table: string) {
        return {
          select: () => thenable(table),
          insert: () => {
            written.push(`${table}.insert`);
            throw new Error(`the double refused an insert into ${table}`);
          },
          update: () => {
            written.push(`${table}.update`);
            throw new Error(`the double refused an update of ${table}`);
          },
        };
      },
      async rpc(name: string) {
        written.push(`rpc.${name}`);
        throw new Error(`the double refused ${name}`);
      },
    };

    return { touched, written, client: client as unknown as SupabaseClient };
  }

  /** Providers that fail the test if a refused request ever reaches one. */
  const providers = {
    sendSms: async () => {
      throw new Error('a refused manual send reached the SMS provider');
    },
    sendEmail: async () => {
      throw new Error('a refused manual send reached the email provider');
    },
    isEmailConfigured: () => false,
  };

  function actor(role: AppRole, profileId = SELF): ManualSendActor {
    return { profileId, role };
  }

  const SEND_CASE = { ...caseRow(), assigned_to: SELF };

  it('answers 403 to Retry Failed Communication from every Agent_Role profile, before any read', async () => {
    for (const role of AGENT_ROLES) {
      const store = sendClient({ caseRow: SEND_CASE, settings: null });
      const result = await runManualSend({
        client: store.client,
        caseId: CASE_ID,
        action: 'retry_failed',
        actor: actor(role),
        businessDate: '2026-07-16',
        providers,
      });

      expect(result.ok, `${role} was allowed to retry`).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.status).toBe(403);
      expect(result.rejection.code).toBe('forbidden_role');
      expect(result.rejection.message).toBe(RETRY_REQUIRES_MANAGER_MESSAGE);
      expect(store.touched, 'the refusal read rows').toEqual([]);
      expect(store.written, 'the refusal wrote rows').toEqual([]);
    }
  });

  it('answers 403 to a role outside the workspace, before any read', async () => {
    for (const role of OUTSIDE_ROLES) {
      const store = sendClient({ caseRow: SEND_CASE, settings: null });
      const result = await runManualSend({
        client: store.client,
        caseId: CASE_ID,
        action: 'send_now',
        actor: actor(role),
        businessDate: '2026-07-16',
        providers,
      });

      expect(result.ok, `${role} was allowed to send`).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.status).toBe(403);
      expect(result.rejection.message).toBe(ROLE_NOT_PERMITTED_MESSAGE);
      expect(store.touched).toEqual([]);
      expect(store.written).toEqual([]);
    }
  });

  it('answers 403 to an Agent_Role send on a case assigned elsewhere or to nobody', async () => {
    for (const role of AGENT_ROLES) {
      for (const assignedTo of [OTHER, null]) {
        const store = sendClient({
          caseRow: { ...SEND_CASE, assigned_to: assignedTo },
          settings: null,
        });
        const result = await runManualSend({
          client: store.client,
          caseId: CASE_ID,
          action: 'send_now',
          actor: actor(role),
          businessDate: '2026-07-16',
          providers,
        });

        expect(result.ok, `${role} sent for a case assigned to ${String(assignedTo)}`).toBe(false);
        if (result.ok) continue;
        expect(result.rejection.status).toBe(403);
        expect(result.rejection.code).toBe('forbidden_case_scope');
        expect(result.rejection.message).toBe(CASE_NOT_ASSIGNED_MESSAGE);
        // The case row is read to decide scope, and nothing beyond it is touched.
        expect(store.touched).toEqual(['cancellation_cases']);
        expect(store.written).toEqual([]);
      }
    }
  });

  it('lets an Agent_Role profile past both gates on a case assigned to itself', async () => {
    for (const role of AGENT_ROLES) {
      const store = sendClient({ caseRow: SEND_CASE, settings: null });
      const result = await runManualSend({
        client: store.client,
        caseId: CASE_ID,
        action: 'send_now',
        actor: actor(role),
        businessDate: '2026-07-16',
        providers,
      });

      // No settings row is seeded, so the action stops at step 3 — which is only reachable once
      // both authorization gates have passed, and still writes nothing.
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.rejection.code, `${role} was refused its own case`).toBe('settings_absent');
      expect(result.rejection.status).toBe(503);
      expect(store.touched).toEqual(['cancellation_cases', 'cancellation_settings']);
      expect(store.written).toEqual([]);
    }
  });

  it('lets manager and super_admin past both gates on any case, retry included', async () => {
    for (const role of MANAGER_ROLES) {
      for (const assignedTo of [SELF, OTHER, null]) {
        for (const action of ['send_now', 'retry_failed'] as const) {
          const store = sendClient({
            caseRow: { ...SEND_CASE, assigned_to: assignedTo },
            settings: null,
          });
          const result = await runManualSend({
            client: store.client,
            caseId: CASE_ID,
            action,
            actor: actor(role),
            businessDate: '2026-07-16',
            providers,
          });

          expect(result.ok).toBe(false);
          if (result.ok) continue;
          expect(
            result.rejection.code,
            `${role} was refused ${action} on a case assigned to ${String(assignedTo)}`,
          ).toBe('settings_absent');
          expect(store.written).toEqual([]);
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PART B — the policy predicates as written in v1.10.6
// ═══════════════════════════════════════════════════════════════════════════

/** The repository root: the nearest ancestor of the working directory holding a `package.json`. */
function repositoryRoot(): string {
  let current = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('No package.json found above the working directory.');
    current = parent;
  }
}

const ROOT = repositoryRoot();
const RLS_MIGRATION = 'supabase/migrations/v1.10.6-cancellation-rls.sql';
const CORE_MIGRATION = 'supabase/migrations/v1.10.0-cancellation-core-tables.sql';

/**
 * The file with every comment removed and every string literal left where it was.
 *
 * Comments are detected before strings, so an apostrophe inside prose ("this file's") cannot open
 * a string; dollar-quoted bodies are copied verbatim, because their `--` lines are inside a single
 * statement this file never parses.
 */
function stripSqlComments(sql: string): string {
  const out: string[] = [];
  const blank = (character: string): string => (character === '\n' ? '\n' : ' ');
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];

    if (character === '$') {
      const tag = /^\$[a-zA-Z_]*\$/.exec(sql.slice(index));
      if (tag !== null) {
        const marker = tag[0];
        const end = sql.indexOf(marker, index + marker.length);
        const stop = end === -1 ? sql.length : end + marker.length;
        out.push(sql.slice(index, stop));
        index = stop;
        continue;
      }
    }

    if (character === "'") {
      out.push(character);
      index += 1;
      while (index < sql.length) {
        out.push(sql[index]);
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            out.push(sql[index + 1]);
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (character === '-' && sql[index + 1] === '-') {
      while (index < sql.length && sql[index] !== '\n') {
        out.push(blank(sql[index]));
        index += 1;
      }
      continue;
    }

    if (character === '/' && sql[index + 1] === '*') {
      out.push(' ', ' ');
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
        out.push(blank(sql[index]));
        index += 1;
      }
      if (index < sql.length) {
        out.push(' ', ' ');
        index += 2;
      }
      continue;
    }

    out.push(character);
    index += 1;
  }

  return out.join('');
}

/** Whitespace removed entirely, so a predicate compares by content and not by formatting. */
function compact(sql: string): string {
  return sql.replace(/\s+/g, '').toLowerCase();
}

/** The text inside the parenthesis group that starts at `open`, without the parentheses. */
function balanced(text: string, open: number): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  throw new Error(`unbalanced parenthesis at offset ${open}`);
}

/** The clause introduced by `keyword`, or `null` where the statement has none. */
function clause(statement: string, keyword: RegExp): string | null {
  const match = keyword.exec(statement);
  if (match === null) return null;
  const open = statement.indexOf('(', match.index + match[0].length - 1);
  if (open === -1) return null;
  return balanced(statement, open);
}

interface PolicyDefinition {
  name: string;
  table: string;
  command: 'select' | 'insert' | 'update' | 'delete' | 'all';
  roles: string[];
  using: string | null;
  withCheck: string | null;
  /** `using` and `with check` together, compacted — what a predicate assertion reads. */
  predicate: string;
}

const POLICY_HEAD =
  /^create\s+policy\s+([a-z0-9_]+)\s+on\s+(?:public\.)?([a-z0-9_]+)\s+for\s+(select|insert|update|delete|all)\s+to\s+([a-z0-9_,\s]+?)\s+(?=using\s*\(|with\s+check\s*\()/i;

function parsePolicies(code: string): PolicyDefinition[] {
  const policies: PolicyDefinition[] = [];

  for (const raw of code.split(';')) {
    const statement = raw.trim();
    if (!/^create\s+policy\b/i.test(statement)) continue;

    const head = POLICY_HEAD.exec(statement);
    if (head === null) throw new Error(`unparsed create policy statement: ${statement.slice(0, 120)}`);

    const using = clause(statement, /\busing\s*\(/i);
    const withCheck = clause(statement, /\bwith\s+check\s*\(/i);

    policies.push({
      name: head[1].toLowerCase(),
      table: head[2].toLowerCase(),
      command: head[3].toLowerCase() as PolicyDefinition['command'],
      roles: head[4]
        .split(',')
        .map((role) => role.trim().toLowerCase())
        .filter((role) => role.length > 0),
      using,
      withCheck,
      predicate: compact(`${using ?? ''} ${withCheck ?? ''}`),
    });
  }

  return policies;
}

const RLS_SQL = fs.readFileSync(path.join(ROOT, RLS_MIGRATION), 'utf8');
const RLS_CODE = stripSqlComments(RLS_SQL);
const CORE_CODE = stripSqlComments(fs.readFileSync(path.join(ROOT, CORE_MIGRATION), 'utf8'));
const POLICIES = parsePolicies(RLS_CODE);

const IS_MANAGER = 'public.cancellation_is_manager()';
const CAN_READ_ALL = 'public.cancellation_can_read_all()';

/** The sixteen `cancellation_*` tables and the policy count the design's RLS table fixes. */
const EXPECTED_TABLES: readonly { table: string; select: number; insert: number; update: number }[] = [
  { table: 'cancellation_import_runs', select: 1, insert: 1, update: 0 },
  { table: 'cancellation_cases', select: 1, insert: 1, update: 2 },
  { table: 'cancellation_contacts', select: 1, insert: 1, update: 1 },
  { table: 'cancellation_suppressions', select: 1, insert: 1, update: 1 },
  { table: 'cancellation_events', select: 1, insert: 1, update: 0 },
  { table: 'cancellation_templates', select: 1, insert: 1, update: 0 },
  { table: 'cancellation_template_versions', select: 1, insert: 1, update: 0 },
  { table: 'cancellation_prohibited_phrases', select: 1, insert: 1, update: 0 },
  { table: 'cancellation_communications', select: 1, insert: 1, update: 0 },
  { table: 'cancellation_communication_cases', select: 1, insert: 1, update: 0 },
  { table: 'cancellation_settings', select: 1, insert: 0, update: 1 },
  { table: 'cancellation_notes', select: 1, insert: 1, update: 0 },
  { table: 'cancellation_customer_responses', select: 1, insert: 1, update: 0 },
  { table: 'cancellation_payment_reports', select: 1, insert: 1, update: 0 },
  { table: 'cancellation_verification_outcomes', select: 1, insert: 1, update: 0 },
  { table: 'cancellation_escalations', select: 1, insert: 1, update: 2 },
];

/** The tables whose read scope follows the case through a `case_id` join (Requirement 22.1). */
const CASE_SCOPED_TABLES = [
  'cancellation_contacts',
  'cancellation_events',
  'cancellation_communications',
  'cancellation_communication_cases',
  'cancellation_notes',
  'cancellation_customer_responses',
  'cancellation_payment_reports',
  'cancellation_verification_outcomes',
  'cancellation_escalations',
] as const;

/** The tables every signed-in profile reads whole: no case to scope to. */
const SESSION_SCOPED_TABLES = [
  'cancellation_suppressions',
  'cancellation_templates',
  'cancellation_template_versions',
  'cancellation_prohibited_phrases',
  'cancellation_settings',
] as const;

/** Write policies with no non-manager path at all (Requirements 19.11, 22.3, 26.4). */
const MANAGER_ONLY_WRITE_POLICIES = [
  'cancellation_import_runs_v1106_insert',
  'cancellation_cases_v1106_insert',
  'cancellation_cases_v1106_update_manager',
  'cancellation_suppressions_v1106_update_manager',
  'cancellation_templates_v1106_insert',
  'cancellation_template_versions_v1106_insert',
  'cancellation_prohibited_phrases_v1106_insert',
  'cancellation_settings_v1106_update_manager',
  'cancellation_verification_outcomes_v1106_insert',
  'cancellation_escalations_v1106_update_manager',
] as const;

/**
 * Write policies a non-manager can satisfy, each of which must require the case be assigned to the
 * acting profile (Requirements 22.2, 22.12).
 *
 * `cancellation_events_v1106_insert` is deliberately absent: the migration scopes an audit write to
 * a *readable* case rather than an owned one, because the timeline entry for an action is written by
 * whatever session performed it and a silently dropped audit write loses history. It is asserted
 * separately below, together with the fact that it is no wider than the read scope.
 */
const OWN_CASE_WRITE_POLICIES = [
  'cancellation_cases_v1106_update_own',
  'cancellation_contacts_v1106_insert',
  'cancellation_contacts_v1106_update',
  'cancellation_communications_v1106_insert',
  'cancellation_communication_cases_v1106_insert',
  'cancellation_notes_v1106_insert',
  'cancellation_customer_responses_v1106_insert',
  'cancellation_payment_reports_v1106_insert',
  'cancellation_escalations_v1106_insert',
  'cancellation_escalations_v1106_update_own',
] as const;

function policy(name: string): PolicyDefinition {
  const found = POLICIES.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`v1.10.6 defines no policy named ${name}; it defines ${POLICIES.length}`);
  }
  return found;
}

function policiesFor(table: string, command?: PolicyDefinition['command']): PolicyDefinition[] {
  return POLICIES.filter(
    (candidate) => candidate.table === table && (command === undefined || candidate.command === command),
  );
}

/** The case read scope, as `cancellation_cases` states it about its own row. */
const CASE_READ_SCOPE = compact(
  `${CAN_READ_ALL} or (auth.uid() is not null and (assigned_to = auth.uid() or assigned_to is null))`,
);

/** The same scope reached through a `case_id` join from another table. */
function caseScopedRead(table: string): string {
  return compact(`exists (
    select 1 from public.cancellation_cases c
     where c.id = ${table}.case_id
       and (
         ${CAN_READ_ALL}
         or (auth.uid() is not null and (c.assigned_to = auth.uid() or c.assigned_to is null))
       )
  )`);
}

describe('the migration scan found what it claims to check', () => {
  it('parses 38 policies over the sixteen cancellation tables', () => {
    expect(POLICIES).toHaveLength(38);
    expect(EXPECTED_TABLES).toHaveLength(16);

    const parsedTables = [...new Set(POLICIES.map((candidate) => candidate.table))].sort();
    expect(parsedTables).toEqual(EXPECTED_TABLES.map((entry) => entry.table).sort());

    for (const entry of EXPECTED_TABLES) {
      expect(policiesFor(entry.table, 'select'), `${entry.table} select`).toHaveLength(entry.select);
      expect(policiesFor(entry.table, 'insert'), `${entry.table} insert`).toHaveLength(entry.insert);
      expect(policiesFor(entry.table, 'update'), `${entry.table} update`).toHaveLength(entry.update);
    }
  });

  it('reads a predicate for every policy and names each policy after its table', () => {
    for (const candidate of POLICIES) {
      expect(candidate.predicate.length, `${candidate.name} has an empty predicate`).toBeGreaterThan(0);
      expect(candidate.name.startsWith(`${candidate.table}_v1106_`), candidate.name).toBe(true);
      // A select policy has `using` and no `with check`; an insert policy the reverse.
      if (candidate.command === 'select') expect(candidate.using, candidate.name).not.toBeNull();
      if (candidate.command === 'insert') expect(candidate.withCheck, candidate.name).not.toBeNull();
    }
  });

  it('drops each of the 38 policies by name before creating it, so the file re-applies', () => {
    const dropped = [...RLS_CODE.matchAll(/drop\s+policy\s+if\s+exists\s+([a-z0-9_]+)\s+on\s+/gi)].map(
      (match) => match[1].toLowerCase(),
    );
    expect([...dropped].sort()).toEqual(POLICIES.map((candidate) => candidate.name).sort());
  });

  it('enables row level security by enumerating the catalog, and refuses to stop short of sixteen', () => {
    // The migration does not name sixteen tables in sixteen statements: it loops over every
    // `cancellation%` relation, so a table added later cannot be missed, and raises below sixteen.
    expect(compact(RLS_CODE)).toContain(
      compact("execute format('alter table public.%I enable row level security', v_table)"),
    );
    expect(compact(RLS_CODE)).toContain(compact("c.relname like 'cancellation%'"));
    expect(compact(RLS_CODE)).toContain(compact('if v_count < 16 then'));
    // And the post-condition re-reads the catalog, failing on any unprotected table.
    expect(compact(RLS_CODE)).toContain(compact('and not c.relrowsecurity'));
    expect(RLS_CODE).toMatch(/raise exception 'v1\.10\.6 left row level security disabled on: %'/i);
  });
});

describe('every role decision goes through the two helpers (Requirements 22.5, 22.9)', () => {
  it('names no role literal in any policy predicate', () => {
    // This is what makes `super_admin` impossible to omit: no policy decides a role itself, so
    // there is exactly one definition of the manager set and one of the read-all set.
    const offenders = POLICIES.filter((candidate) =>
      APP_ROLES.some((role) => candidate.predicate.includes(`'${role}'`)),
    ).map((candidate) => candidate.name);
    expect(offenders, `policies naming a role literal: ${offenders.join(', ')}`).toEqual([]);
  });

  it('calls only the two role helpers and the status accessor', () => {
    const allowed = new Set([
      'cancellation_can_read_all',
      'cancellation_is_manager',
      'cancellation_case_stored_status',
    ]);
    const called = new Set<string>();
    for (const candidate of POLICIES) {
      for (const match of candidate.predicate.matchAll(/public\.([a-z0-9_]+)\(/g)) {
        called.add(match[1]);
      }
    }
    expect([...called].sort()).toEqual([...allowed].sort());
  });

  it('does not redefine either helper, so the v1.10.0 definitions are the live ones', () => {
    expect(RLS_CODE).not.toMatch(/function\s+public\.cancellation_is_manager/i);
    expect(RLS_CODE).not.toMatch(/function\s+public\.cancellation_can_read_all/i);
  });

  it('defines cancellation_is_manager as manager and super_admin, and nothing else', () => {
    expect(compact(CORE_CODE)).toContain(compact("select role in ('manager', 'super_admin') from public.profiles"));
    expect(compact(CORE_CODE)).toContain(
      compact(
        "select role in ('manager', 'super_admin', 'customer_service', 'sales_supervisor')\n from public.profiles",
      ),
    );
  });

  it('leaves agent out of both helper role sets, which is what hides the import runs', () => {
    const helperText = /create or replace function public\.cancellation_(is_manager|can_read_all)[\s\S]*?\$\$;/gi;
    const bodies = [...CORE_CODE.matchAll(helperText)].map((match) => match[0]);
    expect(bodies, 'neither helper definition was found in v1.10.0').toHaveLength(2);
    for (const body of bodies) {
      expect(body).not.toContain("'agent'");
      expect(body).toContain("'super_admin'");
      expect(body).toContain("'manager'");
    }
  });

  it('scopes every policy to authenticated and to nothing else', () => {
    for (const candidate of POLICIES) {
      expect(candidate.roles, candidate.name).toEqual(['authenticated']);
    }
  });
});

describe('the read scope (Requirements 22.1, 22.3, 22.12)', () => {
  it('scopes cancellation_cases to read-all, own rows, and unassigned rows', () => {
    expect(compact(policy('cancellation_cases_v1106_select').using ?? '')).toBe(CASE_READ_SCOPE);
  });

  it('reaches the same scope from every case-scoped table', () => {
    for (const table of CASE_SCOPED_TABLES) {
      const selects = policiesFor(table, 'select');
      expect(selects, `${table} select policy`).toHaveLength(1);
      expect(compact(selects[0].using ?? ''), `${table} read scope`).toBe(caseScopedRead(table));
    }
  });

  it('opens the configuration tables to any signed-in profile', () => {
    for (const table of SESSION_SCOPED_TABLES) {
      const selects = policiesFor(table, 'select');
      expect(selects, `${table} select policy`).toHaveLength(1);
      expect(compact(selects[0].using ?? ''), `${table} read scope`).toBe(
        compact('auth.uid() is not null'),
      );
    }
  });

  it('restricts cancellation_import_runs to the read-all set, with no path for agent', () => {
    // Requirement 22.1: an import run row spans cases an `agent` profile cannot read, so the
    // design gives that role no select at all. The only predicate is the read-all helper, which
    // the assertion above proved excludes `agent`.
    const select = policy('cancellation_import_runs_v1106_select');
    expect(compact(select.using ?? '')).toBe(compact(CAN_READ_ALL));
    for (const candidate of policiesFor('cancellation_import_runs')) {
      expect(candidate.predicate, `${candidate.name} admits a case owner`).not.toContain('assigned_to');
      expect(candidate.predicate).not.toContain('auth.uid()isnotnull');
    }
  });
});

describe('the write scope (Requirements 22.2, 22.3, 22.12)', () => {
  it('accounts for every write policy as manager-only or own-case', () => {
    const writePolicies = POLICIES.filter((candidate) => candidate.command !== 'select')
      .map((candidate) => candidate.name)
      .sort();
    const accounted = [
      ...MANAGER_ONLY_WRITE_POLICIES,
      ...OWN_CASE_WRITE_POLICIES,
      // The two writes that are neither: an opt-out any profile may record, and the audit insert.
      'cancellation_suppressions_v1106_insert',
      'cancellation_events_v1106_insert',
    ].sort();
    expect(writePolicies).toEqual(accounted);
  });

  it('gives the manager-only writes no non-manager path', () => {
    for (const name of MANAGER_ONLY_WRITE_POLICIES) {
      const candidate = policy(name);
      expect(candidate.predicate, `${name} does not call the manager helper`).toContain(
        compact(IS_MANAGER),
      );
      expect(candidate.predicate, `${name} admits a case owner`).not.toContain('assigned_to');
    }
  });

  it('requires the case be assigned to the acting profile on every non-manager write', () => {
    for (const name of OWN_CASE_WRITE_POLICIES) {
      const candidate = policy(name);
      expect(candidate.predicate, `${name} does not require ownership`).toContain(
        'assigned_to=auth.uid()',
      );
      // Requirement 22.12 reserves a write to an unassigned record to Manager_Role, so the
      // ownership branch may not fall back to `assigned_to is null` the way the read scope does.
      expect(candidate.predicate, `${name} lets a non-manager write an unassigned case`).not.toContain(
        'assigned_toisnull',
      );
    }
  });

  it('keeps the audit insert no wider than the read scope, and pinned to the acting profile', () => {
    const insert = policy('cancellation_events_v1106_insert');
    expect(insert.predicate).toContain(compact('(actor_id is null or actor_id = auth.uid())'));
    expect(insert.predicate).toContain(caseScopedRead('cancellation_events'));
  });

  it('pins the recorded profile on every self-attributed write', () => {
    const expected: Record<string, string> = {
      cancellation_import_runs_v1106_insert: 'imported_by=auth.uid()',
      cancellation_notes_v1106_insert: 'created_by=auth.uid()',
      cancellation_customer_responses_v1106_insert: 'created_by=auth.uid()',
      cancellation_payment_reports_v1106_insert: 'reported_by=auth.uid()',
      cancellation_verification_outcomes_v1106_insert: 'recorded_by=auth.uid()',
      cancellation_settings_v1106_update_manager: 'updated_by=auth.uid()',
      cancellation_suppressions_v1106_insert: 'actor_id=auth.uid()',
    };
    for (const [name, requirement] of Object.entries(expected)) {
      expect(policy(name).predicate, name).toContain(requirement);
    }
  });
});

describe('the four Case_Status values a non-manager may set (Requirement 22.10)', () => {
  /** The values of the first `in (...)` list applied to `case_status` in a predicate. */
  function statusList(predicate: string, negated: boolean): string[] {
    const pattern = negated ? /case_status\s+not\s+in\s*\(/i : /case_status\s+in\s*\(/i;
    const match = pattern.exec(predicate);
    expect(match, `no ${negated ? 'negated ' : ''}case_status list in the predicate`).not.toBeNull();
    if (match === null) return [];
    const open = predicate.indexOf('(', match.index + match[0].length - 1);
    return balanced(predicate, open)
      .split(',')
      .map((value) => value.trim().replace(/^'|'$/g, ''));
  }

  const own = policy('cancellation_cases_v1106_update_own');

  it('permits exactly the four values api.ts names, read from the policy itself', () => {
    expect(statusList(own.withCheck ?? '', false).sort()).toEqual(
      [...AGENT_SETTABLE_CASE_STATUSES].sort(),
    );
  });

  it('excludes exactly the five closed statuses api.ts names', () => {
    expect(statusList(own.using ?? '', true).sort()).toEqual([...TERMINAL_CASE_STATUSES].sort());
  });

  it('allows an update that did not touch the status through the stored-status accessor', () => {
    // Without this branch an agent flipping `assistance_requested` on a case still at `Imported`
    // would be refused for a column it never wrote.
    expect(own.predicate).toContain('case_status=public.cancellation_case_stored_status(id)');
  });

  it('keeps the row assigned to the same profile, so a non-manager cannot self-assign', () => {
    expect(compact(own.withCheck ?? '')).toContain('assigned_to=auth.uid()');
    expect(compact(own.using ?? '')).toContain('assigned_to=auth.uid()');
  });

  it('leaves every other status change to the manager policy', () => {
    const manager = policy('cancellation_cases_v1106_update_manager');
    expect(compact(manager.using ?? '')).toBe(compact(IS_MANAGER));
    expect(compact(manager.withCheck ?? '')).toBe(compact(IS_MANAGER));
    expect(manager.predicate).not.toContain('case_status');
  });
});

describe('payment verification outcomes have no insert path outside Manager_Role (Req 19.11)', () => {
  it('checks the manager helper and the recording profile, and nothing else', () => {
    const insert = policy('cancellation_verification_outcomes_v1106_insert');
    expect(compact(insert.withCheck ?? '')).toBe(compact(`${IS_MANAGER} and recorded_by = auth.uid()`));
    expect(insert.using).toBeNull();
  });

  it('gives the table exactly one insert policy and no update or delete policy', () => {
    expect(policiesFor('cancellation_verification_outcomes', 'insert')).toHaveLength(1);
    expect(policiesFor('cancellation_verification_outcomes', 'update')).toEqual([]);
    expect(policiesFor('cancellation_verification_outcomes', 'delete')).toEqual([]);
    expect(policiesFor('cancellation_verification_outcomes', 'all')).toEqual([]);
  });

  it('leaves the read open to the case, so the reporting agent sees the outcome', () => {
    expect(compact(policy('cancellation_verification_outcomes_v1106_select').using ?? '')).toBe(
      caseScopedRead('cancellation_verification_outcomes'),
    );
  });
});

describe('stored communications and audit entries cannot be changed (Requirement 22.8)', () => {
  it('gives cancellation_communications and cancellation_events no update or delete policy', () => {
    for (const table of ['cancellation_communications', 'cancellation_events']) {
      expect(policiesFor(table, 'update'), `${table} update policy`).toEqual([]);
      expect(policiesFor(table, 'delete'), `${table} delete policy`).toEqual([]);
      expect(policiesFor(table, 'all'), `${table} FOR ALL policy`).toEqual([]);
      expect(policiesFor(table).map((candidate) => candidate.command).sort()).toEqual([
        'insert',
        'select',
      ]);
    }
  });

  it('creates no delete policy and no FOR ALL policy on any cancellation table', () => {
    const offenders = POLICIES.filter(
      (candidate) => candidate.command === 'delete' || candidate.command === 'all',
    ).map((candidate) => `${candidate.name} (${candidate.command})`);
    expect(offenders, offenders.join(', ')).toEqual([]);
  });

  it('revokes the privileges row level security cannot reach', () => {
    // TRUNCATE is never checked against a policy and fires no row trigger, so a client role
    // holding it empties an append-only table in one statement.
    expect(compact(RLS_CODE)).toContain(
      compact("revoke truncate on public.%I from authenticated, anon, service_role"),
    );
    expect(compact(RLS_CODE)).toContain(compact('revoke delete on public.%I from authenticated, anon'));
    expect(compact(RLS_CODE)).toContain(
      compact('revoke update, delete on public.cancellation_events from service_role'),
    );
  });
});
