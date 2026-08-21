/**
 * Spec: carrier email submission production fix, items 1, 2 and 7.
 *
 * The rule under test is "never hide, always explain". So the assertions are mostly about
 * what is REPORTED, not about a boolean.
 */

import { describe, expect, it } from 'vitest';

import { accountBlockers, carrierBlockers, readinessSummary } from '../readiness';

const READY_ACCOUNT = {
  canSend: true,
  providerConfigured: true,
  encryptionConfigured: true,
  connectionStatus: 'connected' as const,
};

const READY_CARRIER = {
  marketLinked: true,
  emailSubmissionEnabled: true,
  submissionEmail: 'submissions@carrier.com',
  marketLoaded: true,
  quoteClosed: false,
};

describe('account readiness', () => {
  it('reports nothing when everything is in place', () => {
    expect(accountBlockers(READY_ACCOUNT)).toEqual([]);
  });

  it('explains a non-sender instead of returning a bare false', () => {
    const [blocker, ...rest] = accountBlockers({ ...READY_ACCOUNT, canSend: false });
    expect(blocker.code).toBe('not_a_sender');
    expect(blocker.message).toContain('not enabled for your account');
    expect(blocker.remedy).toContain('can_send_carrier_submissions');
    // Only one. The state of a mailbox they may not use is not their problem.
    expect(rest).toEqual([]);
  });

  it('does not pile on mailbox problems for someone who may not send', () => {
    const blockers = accountBlockers({
      canSend: false,
      providerConfigured: false,
      encryptionConfigured: false,
      connectionStatus: null,
    });
    expect(blockers.map((b) => b.code)).toEqual(['not_a_sender']);
  });

  it('distinguishes an unconfigured environment from an unconnected mailbox', () => {
    // These look identical to a user and have completely different remedies: one is an
    // administrator's job, the other takes thirty seconds.
    const unconfigured = accountBlockers({ ...READY_ACCOUNT, providerConfigured: false });
    expect(unconfigured.map((b) => b.code)).toEqual(['provider_not_configured']);

    const disconnected = accountBlockers({ ...READY_ACCOUNT, connectionStatus: null });
    expect(disconnected.map((b) => b.code)).toEqual(['mailbox_not_connected']);
  });

  it('reports a missing encryption key separately from missing OAuth settings', () => {
    const blockers = accountBlockers({ ...READY_ACCOUNT, encryptionConfigured: false });
    expect(blockers.map((b) => b.code)).toEqual(['encryption_not_configured']);
    // Points at the guide rather than naming the variable, so the credential name stays
    // inside the module that owns it. provider-isolation.test.ts enforces that.
    expect(blockers[0].remedy).toContain('encryption key');
    expect(blockers[0].remedy).toContain('LIVE-DEPLOYMENT-GUIDE');
    expect(blockers[0].remedy).not.toContain('EMAIL_TOKEN');
  });

  it('separates needs_reconnect from never connected', () => {
    const stale = accountBlockers({ ...READY_ACCOUNT, connectionStatus: 'needs_reconnect' });
    expect(stale.map((b) => b.code)).toEqual(['mailbox_needs_reconnect']);
    expect(stale[0].remedy).toContain('Reconnect');
  });

  it('reports every environment problem at once so one fix does not reveal another', () => {
    const blockers = accountBlockers({
      canSend: true,
      providerConfigured: false,
      encryptionConfigured: false,
      connectionStatus: null,
    });
    expect(blockers.map((b) => b.code)).toEqual([
      'provider_not_configured',
      'encryption_not_configured',
      'mailbox_not_connected',
    ]);
  });
});

describe('carrier readiness', () => {
  it('reports nothing for a fully configured carrier', () => {
    expect(carrierBlockers(READY_CARRIER)).toEqual([]);
  });

  it('names an unlinked carrier and stops there', () => {
    const blockers = carrierBlockers({ ...READY_CARRIER, marketLinked: false });
    expect(blockers.map((b) => b.code)).toEqual(['carrier_not_linked']);
    expect(blockers[0].managerFixable).toBe(true);
  });

  it('does NOT claim a carrier is broken while its market is still loading', () => {
    // Otherwise every carrier flashes "misconfigured" on first paint and then corrects
    // itself, which teaches people to ignore the warning.
    const blockers = carrierBlockers({
      ...READY_CARRIER,
      marketLoaded: false,
      emailSubmissionEnabled: false,
      submissionEmail: null,
    });
    expect(blockers).toEqual([]);
  });

  it('reports a disabled carrier and a missing address independently', () => {
    expect(carrierBlockers({ ...READY_CARRIER, emailSubmissionEnabled: false }).map((b) => b.code))
      .toEqual(['email_submission_disabled']);
    expect(carrierBlockers({ ...READY_CARRIER, submissionEmail: null }).map((b) => b.code))
      .toEqual(['submission_email_missing']);
    expect(carrierBlockers({ ...READY_CARRIER, submissionEmail: '   ' }).map((b) => b.code))
      .toEqual(['submission_email_missing']);
  });

  it('reports both when both are wrong', () => {
    const blockers = carrierBlockers({
      ...READY_CARRIER, emailSubmissionEnabled: false, submissionEmail: null,
    });
    expect(blockers.map((b) => b.code)).toEqual([
      'email_submission_disabled',
      'submission_email_missing',
    ]);
  });

  it('marks the carrier problems as manager-fixable and the account ones as not', () => {
    // This is what decides whether a [Configure carrier] button appears.
    for (const blocker of carrierBlockers({ ...READY_CARRIER, emailSubmissionEnabled: false })) {
      expect(blocker.managerFixable).toBe(true);
    }
    for (const blocker of accountBlockers({ ...READY_ACCOUNT, connectionStatus: null })) {
      expect(blocker.managerFixable).toBe(false);
    }
  });

  it('reports a closed quote', () => {
    expect(carrierBlockers({ ...READY_CARRIER, quoteClosed: true }).map((b) => b.code))
      .toEqual(['quote_closed']);
  });
});

describe('summary line', () => {
  it('says ready, names a single problem, and counts several', () => {
    expect(readinessSummary([])).toBe('Ready to submit');
    expect(readinessSummary(carrierBlockers({ ...READY_CARRIER, submissionEmail: null })))
      .toContain('no submission email');
    expect(readinessSummary(carrierBlockers({
      ...READY_CARRIER, emailSubmissionEnabled: false, submissionEmail: null,
    }))).toBe('2 things to sort out first');
  });
});
