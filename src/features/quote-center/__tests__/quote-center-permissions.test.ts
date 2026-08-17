/**
 * Who can do what with a quote.
 *
 * Two things are being protected here. First, that every role which works quotes
 * can find and document them — the whole point of shared drafts and shared notes.
 * Second, that widening access did not leak quote data to a role that has no
 * business with it.
 *
 * These helpers only decide what to render. The database re-derives the same
 * answers in can_view_quote_center(), can_edit_cs_intake(), add_quote_note() and
 * cs_intake_add_note(), so the assertions below are about the UI agreeing with the
 * server, not about the server being optional.
 */

import { describe, expect, it } from 'vitest';

import { APP_ROLES } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import {
  addQuoteNote,
  createIntake,
  editSharedDraft,
  getQuoteCenterPermissions,
  manageQuoteAssignments,
  manageQuoteRecords,
  takeIntakeWork,
  viewQuoteCenter,
  viewSalesReporting,
} from '../permissions';

/** The six roles the redesign requires to be tested. */
const QUOTE_ROLES: readonly AppRole[] = [
  'customer_service',
  'agent',
  'customer_service_supervisor',
  'sales_supervisor',
  'manager',
  'super_admin',
];

/**
 * Roles unrelated to the customer-quote pipeline.
 *
 * Commercial quotes have their own board, database and routing, which this
 * consolidation is explicitly not allowed to change. They stand in for "a role
 * that must not gain quote access as a side effect".
 */
const UNRELATED_ROLES: readonly AppRole[] = ['commercial', 'commercial_supervisor'];

describe('Quote Center visibility', () => {
  it('is open to every role that works customer quotes', () => {
    for (const role of QUOTE_ROLES) {
      expect(viewQuoteCenter(role), role).toBe(true);
    }
  });

  it('is closed to roles outside the customer-quote pipeline', () => {
    for (const role of UNRELATED_ROLES) {
      expect(viewQuoteCenter(role), role).toBe(false);
    }
  });

  it('accounts for every role the application declares', () => {
    // If a role is added later, this forces a decision about it rather than
    // letting it silently inherit or silently lose access.
    for (const role of APP_ROLES) {
      const decided = QUOTE_ROLES.includes(role) || UNRELATED_ROLES.includes(role);
      expect(decided, `role ${role} is not covered by this test`).toBe(true);
    }
  });
});

describe('shared drafts', () => {
  it('lets every quote-related role continue a teammate\u2019s unfinished draft', () => {
    // The callback scenario: Vivian starts it, Maria finishes it. Both roles, and
    // every other quote role, must be able to open it.
    for (const role of QUOTE_ROLES) {
      expect(editSharedDraft(role), role).toBe(true);
    }
  });

  it('does not extend shared drafts to unrelated roles', () => {
    for (const role of UNRELATED_ROLES) {
      expect(editSharedDraft(role), role).toBe(false);
    }
  });
});

describe('notes', () => {
  it('lets every quote-related role add a note regardless of who owns the quote', () => {
    // Customer Service documenting a call about a Sales-owned quote, and Sales
    // documenting a CS-started intake, are the same permission.
    for (const role of QUOTE_ROLES) {
      expect(addQuoteNote(role), role).toBe(true);
    }
  });

  it('grants note access to exactly the roles that can view Quote Center', () => {
    // Reading a record and being able to write down what the customer said should
    // never come apart: that gap is how history gets lost.
    for (const role of APP_ROLES) {
      expect(addQuoteNote(role), role).toBe(viewQuoteCenter(role));
    }
  });
});

describe('creating intakes', () => {
  it('is available to quote roles and to commercial roles', () => {
    // Commercial reaches the intake form through the Customer Service module,
    // which this consolidation deliberately preserves for them.
    for (const role of [...QUOTE_ROLES, ...UNRELATED_ROLES]) {
      expect(createIntake(role), role).toBe(true);
    }
  });
});

describe('taking work from the queue', () => {
  it('is offered to the roles that hold rotation turns, plus broad managers', () => {
    expect(takeIntakeWork('agent')).toBe(true);
    expect(takeIntakeWork('sales_supervisor')).toBe(true);
    expect(takeIntakeWork('manager')).toBe(true);
    expect(takeIntakeWork('super_admin')).toBe(true);
  });

  it('is not offered to Customer Service, who submit work rather than take it', () => {
    expect(takeIntakeWork('customer_service')).toBe(false);
    expect(takeIntakeWork('customer_service_supervisor')).toBe(false);
  });

  it('is narrower than Quote Center visibility', () => {
    // Seeing an available intake is not permission to claim it. The RingCentral
    // turn, walk-in authorisation and claim eligibility remain the real gate;
    // this only decides whether a Take action is worth showing.
    const canSee = QUOTE_ROLES.filter(viewQuoteCenter).length;
    const canTake = QUOTE_ROLES.filter(takeIntakeWork).length;
    expect(canTake).toBeLessThan(canSee);
  });
});

describe('management capabilities', () => {
  it('limits assignment changes to sales and customer service management', () => {
    expect(manageQuoteAssignments('manager')).toBe(true);
    expect(manageQuoteAssignments('super_admin')).toBe(true);
    expect(manageQuoteAssignments('sales_supervisor')).toBe(true);
    expect(manageQuoteAssignments('customer_service_supervisor')).toBe(true);
    expect(manageQuoteAssignments('agent')).toBe(false);
    expect(manageQuoteAssignments('customer_service')).toBe(false);
  });

  it('limits record management and reporting to sales management', () => {
    for (const role of ['manager', 'super_admin', 'sales_supervisor'] as AppRole[]) {
      expect(manageQuoteRecords(role), role).toBe(true);
      expect(viewSalesReporting(role), role).toBe(true);
    }
    for (const role of ['agent', 'customer_service', 'customer_service_supervisor'] as AppRole[]) {
      expect(manageQuoteRecords(role), role).toBe(false);
      expect(viewSalesReporting(role), role).toBe(false);
    }
  });
});

describe('super admin parity', () => {
  it('grants super_admin everything a manager has', () => {
    // super_admin inherits every manager permission; a capability a manager has
    // and a super admin does not would be a bug.
    const manager = getQuoteCenterPermissions('manager');
    const superAdmin = getQuoteCenterPermissions('super_admin');

    for (const key of Object.keys(manager) as (keyof typeof manager)[]) {
      if (manager[key]) expect(superAdmin[key], key).toBe(true);
    }
  });
});

describe('the assembled permission object', () => {
  it('matches the individual helpers for every role', () => {
    // One source of truth: the bundle a screen reads must not drift from the
    // helpers a test or a server mirror reads.
    for (const role of APP_ROLES) {
      expect(getQuoteCenterPermissions(role), role).toEqual({
        viewQuoteCenter: viewQuoteCenter(role),
        createIntake: createIntake(role),
        editSharedDraft: editSharedDraft(role),
        addQuoteNote: addQuoteNote(role),
        takeIntakeWork: takeIntakeWork(role),
        manageQuoteAssignments: manageQuoteAssignments(role),
        manageQuoteRecords: manageQuoteRecords(role),
        viewSalesReporting: viewSalesReporting(role),
      });
    }
  });
});
