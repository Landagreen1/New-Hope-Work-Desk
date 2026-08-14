import { describe, expect, it } from 'vitest';

import { APP_ROLES, canAccessRenewals, canManageRenewals } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';
import {
  POLICY_FOLLOW_UP_TABS,
  resolvePolicyFollowUpTab,
} from '../../renewals/PolicyFollowUpPage';
import { POLICY_FOLLOW_UP_TAB_IDS, isManagerOnlyTab } from '../types';

/** Every role that reaches the Policy Follow-up workspace at all. */
const WORKSPACE_ROLES = APP_ROLES.filter((role) => canAccessRenewals(role));

describe('the Policy Follow-up tabs', () => {
  it('offers the five views of Requirement 14.1, with the recommended ids', () => {
    expect(POLICY_FOLLOW_UP_TABS.map((tab) => tab.id))
      .toEqual(['my-work', 'renewals', 'cancellations', 'manager', 'imports']);
  });

  it('keeps the two ids every existing link already uses', () => {
    // `?tab=renewals` and `?tab=cancellations` are in circulation. Renaming either would break
    // links the agency has already shared.
    expect(POLICY_FOLLOW_UP_TAB_IDS).toContain('renewals');
    expect(POLICY_FOLLOW_UP_TAB_IDS).toContain('cancellations');
  });

  it('reserves Manager Overview and Imports to Manager_Role', () => {
    expect(isManagerOnlyTab('manager')).toBe(true);
    expect(isManagerOnlyTab('imports')).toBe(true);
    expect(isManagerOnlyTab('my-work')).toBe(false);
    expect(isManagerOnlyTab('renewals')).toBe(false);
    expect(isManagerOnlyTab('cancellations')).toBe(false);
  });
});

describe('resolvePolicyFollowUpTab', () => {
  it('lands an agent on My Work (Requirement 6.1)', () => {
    expect(resolvePolicyFollowUpTab(null, 'agent')).toBe('my-work');
    expect(resolvePolicyFollowUpTab(null, 'customer_service')).toBe('my-work');
    expect(resolvePolicyFollowUpTab(null, 'sales_supervisor')).toBe('my-work');
  });

  it('lands a manager on Manager Overview (Requirement 9.1)', () => {
    expect(resolvePolicyFollowUpTab(null, 'manager')).toBe('manager');
    expect(resolvePolicyFollowUpTab(null, 'super_admin')).toBe('manager');
  });

  it('honours an existing ?tab=renewals link for every role', () => {
    for (const role of WORKSPACE_ROLES) {
      expect(resolvePolicyFollowUpTab('renewals', role)).toBe('renewals');
      expect(resolvePolicyFollowUpTab('cancellations', role)).toBe('cancellations');
    }
  });

  it('honours ?tab=my-work for every role', () => {
    for (const role of WORKSPACE_ROLES) {
      expect(resolvePolicyFollowUpTab('my-work', role)).toBe('my-work');
    }
  });

  it('opens a manager-only tab for Manager_Role', () => {
    for (const tab of ['manager', 'imports'] as const) {
      expect(resolvePolicyFollowUpTab(tab, 'manager')).toBe(tab);
      expect(resolvePolicyFollowUpTab(tab, 'super_admin')).toBe(tab);
    }
  });

  it('falls back rather than refusing when a non-manager asks for a manager-only tab', () => {
    // The tab is not theirs to be refused from; landing them on their own default is more useful
    // than an error they cannot act on.
    for (const role of WORKSPACE_ROLES.filter((one) => !canManageRenewals(one))) {
      expect(resolvePolicyFollowUpTab('manager', role)).toBe('my-work');
      expect(resolvePolicyFollowUpTab('imports', role)).toBe('my-work');
    }
  });

  it('falls back for an unknown tab value', () => {
    expect(resolvePolicyFollowUpTab('nonsense', 'agent')).toBe('my-work');
    expect(resolvePolicyFollowUpTab('', 'manager')).toBe('manager');
    expect(resolvePolicyFollowUpTab('MY-WORK', 'agent')).toBe('my-work');
  });

  it('resolves to a tab the role may actually open, for every role and every input', () => {
    const inputs: readonly (string | null)[] = [
      null, '', 'my-work', 'renewals', 'cancellations', 'manager', 'imports', 'nonsense',
    ];

    for (const role of APP_ROLES as readonly AppRole[]) {
      for (const input of inputs) {
        const resolved = resolvePolicyFollowUpTab(input, role);
        if (isManagerOnlyTab(resolved)) {
          expect(canManageRenewals(role), `${role} landed on ${resolved}`).toBe(true);
        }
      }
    }
  });
});
