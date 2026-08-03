// @vitest-environment jsdom

// Permission and structural contract of the revised renewals workspace (task 5.5).
//
// Three claims, none of which depends on a database:
//
//  1. `canAccessRenewals` still accepts and denies exactly the roles it accepted and denied before
//     the revision (Req 2.5). The expected result for every role in `APP_ROLES` is pinned here as an
//     explicit literal rather than recomputed from the function, so any later edit to the function —
//     or any role added to `APP_ROLES` without a decision recorded here — fails this file. A denied
//     profile also reaches zero renewal reads through the page container (Req 2.9).
//  2. The secondary manager menu is absent from the rendered workspace for `agent`,
//     `customer_service`, and `sales_supervisor`, and present for `manager` and `super_admin`
//     (Req 6.2, 6.4). Asserted here at the `RenewalsPage` level, which is what Requirement 6.2
//     speaks about: the rendered interface a signed-in profile receives.
//     `renewal-manager-actions.test.tsx` (task 4.2) covers the same visibility rule on
//     `RenewalManagerActions` in isolation, together with the behavior of each of the six controls;
//     this file deliberately overlaps on visibility only and adds no control-level assertion.
//  3. The six components named in Requirement 7.1 hold zero `getSupabase(` and zero `.rpc(`
//     occurrences (Req 7.2) — read from disk, so the assertion covers the source text itself rather
//     than whatever a render happens to exercise.
//
// Only the five container reads of `../api` plus the notification generator are replaced; every
// pure helper and every component renders for real. The file name deviates from the `.test.ts` named
// in task 5.5 because part 2 mounts the page container, so the file carries JSX — the same deviation
// the sibling test files of tasks 3.3, 3.4, and 4.2 already carry.
//
// Validates: Requirements 2.5, 2.9, 6.2, 6.4, 7.2, 25.1

import fs from 'node:fs';
import path from 'node:path';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_ROLES, canAccessRenewals } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';
import type { ProfileLite } from '../../nhwd-shared/types';
import * as api from '../api';
import { MANAGER_ACTION_LABELS } from '../RenewalManagerActions';
import RenewalsPage from '../RenewalsPage';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  listRenewals: vi.fn(),
  listRenewalAssignees: vi.fn(),
  listRenewalAssignmentAliases: vi.fn(),
  listRenewalImportRuns: vi.fn(),
  listRenewalSyncExceptions: vi.fn(),
  generateDueNotifications: vi.fn(),
}));

/**
 * Requirement 2.5: the accept/deny result of `canAccessRenewals` for every role, as the function
 * returned it before the revision. Pinned as literals — never derived from the function under test.
 */
const PRE_REVISION_ACCESS: Record<AppRole, boolean> = {
  agent: true,
  manager: true,
  customer_service: true,
  commercial: false,
  commercial_supervisor: false,
  customer_service_supervisor: false,
  sales_supervisor: true,
  super_admin: true,
};

/** The accepted roles in `APP_ROLES` order, pinned the same way. */
const PRE_REVISION_ACCEPTED: readonly AppRole[] = [
  'agent',
  'manager',
  'customer_service',
  'sales_supervisor',
  'super_admin',
];

/** Roles that reach the renewals workspace without holding Manager_Role (Req 6.2). */
const NON_MANAGER_ROLES: readonly AppRole[] = ['agent', 'customer_service', 'sales_supervisor'];

/** Roles that hold Manager_Role; `super_admin` is asserted alongside `manager` (Req 6.4). */
const MANAGER_ROLES: readonly AppRole[] = ['manager', 'super_admin'];

/** The six component files named in Requirement 7.1. */
const COMPONENT_FILES: readonly string[] = [
  'RenewalsSummaryBar.tsx',
  'RenewalsTable.tsx',
  'RenewalDrawer.tsx',
  'RenewalContactComposer.tsx',
  'RenewalTimeline.tsx',
  'RenewalManagerActions.tsx',
];

const RENEWALS_DIR = path.resolve(__dirname, '..');

function profile(role: AppRole): ProfileLite {
  return { id: 'p-1', display_name: 'Maria Gomez', initials: 'MG', role, is_active: true };
}

/** Mount the workspace and let the container reads settle before anything is asserted. */
async function mountWorkspace(role: AppRole) {
  const view = render(<RenewalsPage initialProfile={profile(role)} />);
  await act(async () => undefined);
  return view;
}

/** Count non-overlapping occurrences of a literal in a source file. */
function countOccurrences(text: string, literal: string): number {
  let count = 0;
  for (let at = text.indexOf(literal); at !== -1; at = text.indexOf(literal, at + literal.length)) count += 1;
  return count;
}

beforeEach(() => {
  vi.mocked(api.listRenewals).mockResolvedValue([]);
  vi.mocked(api.listRenewalAssignees).mockResolvedValue([]);
  vi.mocked(api.listRenewalAssignmentAliases).mockResolvedValue([]);
  vi.mocked(api.listRenewalImportRuns).mockResolvedValue([]);
  vi.mocked(api.listRenewalSyncExceptions).mockResolvedValue([]);
  vi.mocked(api.generateDueNotifications).mockResolvedValue(0);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('canAccessRenewals', () => {
  it('records a pinned accept/deny result for every role in APP_ROLES', () => {
    // A role added to `APP_ROLES` with no entry above, or an entry above for a role that no longer
    // exists, fails here rather than silently skipping the per-role assertions below.
    expect([...APP_ROLES].sort()).toEqual(Object.keys(PRE_REVISION_ACCESS).sort());
    expect(APP_ROLES).toHaveLength(8);
  });

  it.each(APP_ROLES)('returns the pre-revision result for %s', (role) => {
    expect(canAccessRenewals(role)).toBe(PRE_REVISION_ACCESS[role]);
  });

  it('accepts exactly the pre-revision role set', () => {
    expect(APP_ROLES.filter((role) => canAccessRenewals(role))).toEqual([...PRE_REVISION_ACCEPTED]);
    expect(APP_ROLES.filter((role) => !canAccessRenewals(role))).toEqual([
      'commercial',
      'commercial_supervisor',
      'customer_service_supervisor',
    ]);
  });

  it.each(APP_ROLES.filter((role) => !PRE_REVISION_ACCESS[role]))(
    'reads zero renewal rows for the denied role %s',
    async (role) => {
      await mountWorkspace(role);

      // Requirement 2.9: the request is denied and no renewal query runs.
      expect(screen.getByText('Your account does not have Renewals access.')).toBeTruthy();
      expect(api.listRenewals).not.toHaveBeenCalled();
      expect(api.listRenewalAssignees).not.toHaveBeenCalled();
      expect(api.listRenewalAssignmentAliases).not.toHaveBeenCalled();
      expect(api.listRenewalImportRuns).not.toHaveBeenCalled();
      expect(api.listRenewalSyncExceptions).not.toHaveBeenCalled();
    },
  );
});

describe('secondary manager menu in the rendered workspace', () => {
  it.each(NON_MANAGER_ROLES)('is absent from the workspace rendered for %s', async (role) => {
    const { container } = await mountWorkspace(role);

    // The list surface did render, so absence below is a role decision and not a failed mount.
    expect(api.listRenewals).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Search renewals')).toBeTruthy();

    // Requirement 6.2: absent from the rendered interface, not present in a disabled state.
    expect(screen.queryByRole('button', { name: /Manager actions/ })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Manager actions' })).toBeNull();
    for (const label of MANAGER_ACTION_LABELS) expect(container.textContent).not.toContain(label);
  });

  it.each(MANAGER_ROLES)('is present as one collapsed control for %s', async (role) => {
    const { container } = await mountWorkspace(role);

    // Requirement 6.3: one collapsed control, with the six controls revealed on activation.
    const menu = screen.getByRole('button', { name: /Manager actions/ });
    expect(screen.queryByRole('group', { name: 'Manager actions' })).toBeNull();
    for (const label of MANAGER_ACTION_LABELS) expect(container.textContent).not.toContain(label);

    fireEvent.click(menu);

    // Requirement 6.4: `super_admin` receives the same menu as `manager`.
    const group = screen.getByRole('group', { name: 'Manager actions' });
    for (const label of MANAGER_ACTION_LABELS) expect(within(group).getByText(label)).toBeTruthy();
  });
});

describe('renewal components hold no data access', () => {
  it.each(COMPONENT_FILES)('%s contains zero getSupabase( and zero .rpc( occurrences', (fileName) => {
    const source = fs.readFileSync(path.join(RENEWALS_DIR, fileName), 'utf-8');

    // Requirement 7.2: every renewal read and write stays in `api.ts`.
    expect(countOccurrences(source, 'getSupabase(')).toBe(0);
    expect(countOccurrences(source, '.rpc(')).toBe(0);
  });

  it('reads all six Requirement 7.1 component files', () => {
    for (const fileName of COMPONENT_FILES) {
      expect(fs.existsSync(path.join(RENEWALS_DIR, fileName))).toBe(true);
    }
    expect(COMPONENT_FILES).toHaveLength(6);
  });

  it('finds both literals in api.ts, so the zero counts above are not vacuous', () => {
    // Positive control and the other half of Requirement 7.2: the data access the six components
    // hold none of lives in `api.ts`, and this counter does detect it.
    const source = fs.readFileSync(path.join(RENEWALS_DIR, 'api.ts'), 'utf-8');
    expect(countOccurrences(source, 'getSupabase(')).toBeGreaterThan(0);
    expect(countOccurrences(source, '.rpc(')).toBeGreaterThan(0);
  });
});
