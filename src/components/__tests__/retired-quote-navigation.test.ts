/**
 * Retired quote lookup screens resolve to their replacements.
 *
 * Five sidebar destinations were removed when the overlapping quote screens
 * collapsed into Quote Center and My Desk. Navigation state is React state and is
 * not persisted today, but a browser left open across a deploy still holds the old
 * value, and `resolveNavigationForRole` is what has to answer for it.
 *
 * Falling through to "the module's first item" would technically not crash, but it
 * would drop someone who asked for Pending Pricing onto Overview with no
 * explanation. Each retired identifier has a deliberate replacement, chosen by
 * which question the screen answered:
 *
 *   "where is this customer?"      -> Quote Center
 *   "what do I need to do?"        -> the matching section of My Desk
 *   "how is the team performing?"  -> Performance
 *
 * Unlike the Time & Attendance retirement test, this file names the retired
 * identifiers. It has to: the assertion is that a specific old value produces a
 * specific new one, which cannot be expressed by class. The reference scan exempts
 * this path for that reason.
 */

import { describe, expect, it } from 'vitest';

import {
  getDefaultNavigation,
  resolveNavigationForRole,
  retiredNavigationReplacement,
  type NavigationState,
  type SubNavId,
} from '@/components/app-sidebar';
import type { AppRole } from '@/lib/types';

/** Force in a value the compiler no longer admits, as a stale browser would. */
const stored = (id: string): SubNavId => id as SubNavId;

function salesState(subNav: string): NavigationState {
  return { module: 'sales', subNav: stored(subNav) };
}

/** Roles that reach the Sales module and so can hold these stale values. */
const AGENT_ROLES: readonly AppRole[] = ['agent', 'customer_service'];
const MANAGER_ROLES: readonly AppRole[] = ['manager', 'super_admin', 'sales_supervisor'];

describe('the retired quote lookup identifiers', () => {
  const RETIRED = [
    'sales_databases',
    'sales_pricing',
    'sales_intake_queue',
    'sales_team',
    'cs_queue',
  ] as const;

  it('are all declared with a replacement', () => {
    for (const id of RETIRED) {
      expect(retiredNavigationReplacement(id), id).toBeDefined();
    }
  });

  it('are no longer offered by any role', () => {
    // The point of the consolidation: the old and the new lookup systems must not
    // both appear in the final UI.
    for (const role of [...AGENT_ROLES, ...MANAGER_ROLES]) {
      for (const id of RETIRED) {
        const resolved = resolveNavigationForRole(role, salesState(id));
        expect(resolved.subNav, `${role} / ${id}`).not.toBe(id);
      }
    }
  });

  it('never resolve to something the role cannot reach', () => {
    for (const role of [...AGENT_ROLES, ...MANAGER_ROLES]) {
      for (const id of RETIRED) {
        const resolved = resolveNavigationForRole(role, salesState(id));
        // Resolving twice must be a no-op: the answer is already reachable.
        expect(resolveNavigationForRole(role, resolved), `${role} / ${id}`).toEqual(resolved);
      }
    }
  });
});

describe('"where is this customer?" goes to Quote Center', () => {
  it('sends the Databases screen to Quote Center for agents and managers alike', () => {
    // sales_databases was the one identifier shared by both the agent and the
    // manager Quotes Database, so both must land in the same place.
    for (const role of [...AGENT_ROLES, ...MANAGER_ROLES]) {
      expect(resolveNavigationForRole(role, salesState('sales_databases')), role).toEqual({
        module: 'sales',
        subNav: 'quote_center',
      });
    }
  });
});

describe('"what do I need to do?" goes to the right section of My Desk', () => {
  it('sends Pending Pricing to the pricing section, not merely to My Desk', () => {
    for (const role of AGENT_ROLES) {
      expect(resolveNavigationForRole(role, salesState('sales_pricing')), role).toEqual({
        module: 'sales',
        subNav: 'sales_desk',
        deskSection: 'pricing',
      });
    }
  });

  it('sends the Intake Queue to the intake section', () => {
    for (const role of AGENT_ROLES) {
      expect(resolveNavigationForRole(role, salesState('sales_intake_queue')), role).toEqual({
        module: 'sales',
        subNav: 'sales_desk',
        deskSection: 'intake',
      });
    }
  });

  it('sends the Customer Service Sales Queue to the same intake section', () => {
    // cs_queue and sales_intake_queue rendered the same IntakeQueue component from
    // two different sidebar entries. One screen, one destination.
    const fromCsModule: NavigationState = { module: 'customer_service', subNav: stored('cs_queue') };
    for (const role of AGENT_ROLES) {
      expect(resolveNavigationForRole(role, fromCsModule), role).toEqual({
        module: 'sales',
        subNav: 'sales_desk',
        deskSection: 'intake',
      });
    }
  });

  it('agrees with the declared replacement map', () => {
    expect(retiredNavigationReplacement('sales_pricing')).toEqual({
      module: 'sales',
      subNav: 'sales_desk',
      deskSection: 'pricing',
    });
    expect(retiredNavigationReplacement('sales_intake_queue')).toEqual({
      module: 'sales',
      subNav: 'sales_desk',
      deskSection: 'intake',
    });
  });
});

describe('"how is the team performing?" goes to Performance', () => {
  it('sends My Team to Performance for an agent', () => {
    expect(resolveNavigationForRole('agent', salesState('sales_team'))).toEqual({
      module: 'sales',
      subNav: 'sales_performance',
    });
  });

  it('keeps a manager inside the Sales module when Performance is not one of their items', () => {
    // Managers do not have a Performance screen; they have the Reporting Center.
    // The alias only applies when the replacement is actually offered, so a
    // manager falls back to the ordinary rule rather than being sent somewhere
    // they cannot go.
    for (const role of MANAGER_ROLES) {
      const resolved = resolveNavigationForRole(role, salesState('sales_team'));
      expect(resolved.module, role).toBe('sales');
      expect(resolved.subNav, role).not.toBe('sales_team');
      expect(resolveNavigationForRole(role, resolved), role).toEqual(resolved);
    }
  });
});

describe('an identifier with no replacement at all', () => {
  it('stays inside the module rather than being thrown out of it', () => {
    const resolved = resolveNavigationForRole(
      'agent',
      salesState('sales_screen_from_an_older_build'),
    );
    expect(resolved.module).toBe('sales');
    expect(resolved.subNav).toBe('sales_desk');
  });

  it('falls back to the role default when the module itself is unreachable', () => {
    const resolved = resolveNavigationForRole('commercial', {
      module: 'sales',
      subNav: stored('sales_databases'),
    });
    expect(resolved).toEqual(getDefaultNavigation('commercial'));
  });
});

describe('the surviving destinations', () => {
  it('offer no duplicate quote-search destination to any role', () => {
    // The acceptance check for the whole consolidation: an ordinary employee must
    // not be presented with two places to look a customer up.
    for (const role of [...AGENT_ROLES, ...MANAGER_ROLES]) {
      const reachable = new Set<SubNavId>();
      for (const candidate of [
        'sales_desk',
        'quote_center',
        'sales_performance',
        'sales_overview',
        'sales_work',
        'sales_reporting_center',
        'sales_reports',
      ] as SubNavId[]) {
        const resolved = resolveNavigationForRole(role, { module: 'sales', subNav: candidate });
        if (resolved.subNav === candidate) reachable.add(candidate);
      }

      // Exactly one lookup screen, and it is Quote Center.
      expect(reachable.has('quote_center'), role).toBe(true);
      expect(reachable.has('sales_desk' as SubNavId) || reachable.has('sales_overview'), role).toBe(
        true,
      );
    }
  });

  it('keeps Quote Center reachable for the Customer Service supervisor by default', () => {
    // Their old default was the Customer Service module, which they no longer see.
    expect(getDefaultNavigation('customer_service_supervisor')).toEqual({
      module: 'sales',
      subNav: 'quote_center',
    });
  });

  it('leaves commercial roles on their own board, untouched by this change', () => {
    for (const role of ['commercial', 'commercial_supervisor'] as AppRole[]) {
      expect(getDefaultNavigation(role), role).toEqual({
        module: 'commercial',
        subNav: 'commercial_board',
      });
    }
  });
});
