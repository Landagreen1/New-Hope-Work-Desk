// Unit tests for the route-layer authorisation decisions.
//
// Feature: time-attendance-ui-redesign, task 7.2
//
// `resolveActor` itself needs a request scope and a Supabase session, so it is
// exercised by the integration tests rather than here. The two decisions it is
// built from are pure and are asserted here, because both are ways a read could
// answer the wrong thing:
//
//   1. A role the module cannot name is refused, not defaulted. Reading an
//      unrecognised role as `agent` would hand a row nobody can explain the
//      self-scope reads.
//   2. A query naming an employee outside the caller's visibility is refused, not
//      answered with an empty page. An empty page reads as "no records" when the
//      truth is "not yours".
//
// Requirements: 21.1, 21.2, 21.15

import { describe, expect, it } from 'vitest';

import { NOT_VISIBLE_MESSAGE, readActorRole, refuseInvisibleProfiles } from '../api-actor';
import type { Actor } from '../visibility';

const ADMIN: Actor = { id: 'admin-1', role: 'super_admin' };
const EMPLOYEE: Actor = { id: 'emp-a', role: 'agent' };

describe('readActorRole', () => {
  it('accepts every role the application defines', () => {
    expect(readActorRole('agent')).toBe('agent');
    expect(readActorRole('super_admin')).toBe('super_admin');
    expect(readActorRole('customer_service_supervisor')).toBe('customer_service_supervisor');
  });

  it('refuses a role it cannot name rather than defaulting to one', () => {
    expect(readActorRole('root')).toBeNull();
    expect(readActorRole('')).toBeNull();
    expect(readActorRole(undefined)).toBeNull();
    expect(readActorRole(null)).toBeNull();
    expect(readActorRole(7)).toBeNull();
  });
});

describe('refuseInvisibleProfiles', () => {
  it('allows a query naming nobody', async () => {
    expect(await refuseInvisibleProfiles(EMPLOYEE, undefined)).toBeNull();
    expect(await refuseInvisibleProfiles(EMPLOYEE, [])).toBeNull();
  });

  it('allows an employee to name themselves', async () => {
    expect(await refuseInvisibleProfiles(EMPLOYEE, ['emp-a'])).toBeNull();
  });

  it('refuses an employee naming a colleague', async () => {
    const refusal = await refuseInvisibleProfiles(EMPLOYEE, ['emp-b']);

    expect(refusal).not.toBeNull();
    expect(refusal?.status).toBe(403);
    expect(await refusal?.json()).toEqual({
      error: NOT_VISIBLE_MESSAGE,
      code: 'not_visible',
    });
  });

  it('refuses a list where one name is out of scope', async () => {
    // Partial honouring would hand back the caller's own rows and quietly drop
    // the rest, which reads as a complete answer to the question asked.
    expect(await refuseInvisibleProfiles(EMPLOYEE, ['emp-a', 'emp-b'])).not.toBeNull();
  });

  it('allows an administrator to name anybody', async () => {
    expect(await refuseInvisibleProfiles(ADMIN, ['emp-a', 'emp-b', 'emp-c'])).toBeNull();
  });

  it('states what was refused without confirming the employee exists', async () => {
    const refusal = await refuseInvisibleProfiles(EMPLOYEE, ['emp-b']);
    const body = (await refusal?.json()) as { error: string };

    expect(body.error).not.toContain('emp-b');
  });
});
