/**
 * Why a carrier can or cannot be submitted to, as data.
 *
 * Spec: .kiro/specs/carrier-email-submission — production fix, items 1, 2 and 7.
 *
 * THE BUG THIS REPLACES
 *   The first implementation hid the whole feature behind `can_send === true` and hid the
 *   Prepare Submission button behind `connected`. When either was false the screen simply
 *   showed nothing, so the one question a user actually has — *why* — had no answer
 *   anywhere in the product. A blank panel is indistinguishable from a broken deploy, an
 *   unmigrated flag, a missing environment variable, and an unconnected mailbox.
 *
 * So readiness is computed as a LIST OF REASONS rather than a boolean. Nothing is hidden;
 * the action is disabled and the reasons are rendered next to it. This module is pure so
 * the rules can be tested without a browser, a database, or a mailbox.
 */

export type ReadinessBlockerCode =
  | 'not_a_sender'
  | 'provider_not_configured'
  | 'encryption_not_configured'
  | 'mailbox_not_connected'
  | 'mailbox_needs_reconnect'
  | 'carrier_not_linked'
  | 'email_submission_disabled'
  | 'submission_email_missing'
  | 'quote_closed';

export interface ReadinessBlocker {
  code: ReadinessBlockerCode;
  /** What the user reads. States the condition, not the internals. */
  message: string;
  /** What they, or someone, can do about it. */
  remedy: string;
  /** True when a manager can fix it in Market Directory. */
  managerFixable: boolean;
}

/** Account-level readiness: the same for every carrier on every quote. */
export interface AccountReadinessInput {
  canSend: boolean;
  providerConfigured: boolean;
  encryptionConfigured: boolean;
  connectionStatus: 'connected' | 'needs_reconnect' | 'disconnected' | null;
}

export function accountBlockers(input: AccountReadinessInput): ReadinessBlocker[] {
  const blockers: ReadinessBlocker[] = [];

  if (!input.canSend) {
    blockers.push({
      code: 'not_a_sender',
      message: 'Carrier email sending is not enabled for your account.',
      remedy:
        'A manager can enable it by setting can_send_carrier_submissions on your profile. Submission history stays visible to you either way.',
      managerFixable: false,
    });
    // Everything below is about the sender's own mailbox, which is moot if they may not
    // send at all. Reporting four problems when one of them makes the rest irrelevant is
    // noise, not diagnosis.
    return blockers;
  }

  if (!input.providerConfigured) {
    blockers.push({
      code: 'provider_not_configured',
      message: 'Email sending has not been configured for this environment.',
      remedy:
        'An administrator needs to add the Microsoft application settings to this deployment. See LIVE-DEPLOYMENT-GUIDE Part 12.',
      managerFixable: false,
    });
  }

  if (!input.encryptionConfigured) {
    blockers.push({
      code: 'encryption_not_configured',
      message: 'The mailbox token encryption key is missing from this environment.',
      // Deliberately does not name the environment variable. Credential names stay inside
      // the module that owns them, which `provider-isolation.test.ts` enforces — the same
      // reason `TEST_EMAIL_NOT_CONFIGURED_MESSAGE` in the cancellations module names none
      // either. The deployment guide is where an administrator looks anyway.
      remedy:
        'An administrator needs to add the mailbox token encryption key to this deployment and redeploy. See LIVE-DEPLOYMENT-GUIDE Part 12, step 16. Without it a mailbox cannot be connected safely.',
      managerFixable: false,
    });
  }

  if (input.connectionStatus === null || input.connectionStatus === 'disconnected') {
    blockers.push({
      code: 'mailbox_not_connected',
      message: 'Connect your mailbox first.',
      remedy: 'Use Connect mailbox above. It takes about thirty seconds.',
      managerFixable: false,
    });
  } else if (input.connectionStatus === 'needs_reconnect') {
    blockers.push({
      code: 'mailbox_needs_reconnect',
      message: 'Your mailbox connection has expired or was revoked.',
      remedy: 'Use Reconnect above to authorise it again.',
      managerFixable: false,
    });
  }

  return blockers;
}

/** Per-carrier readiness: what is missing on THIS carrier's configuration. */
export interface CarrierReadinessInput {
  /** Null when the carrier has no `market_directory_id`. */
  marketLinked: boolean;
  emailSubmissionEnabled: boolean;
  submissionEmail: string | null;
  /** Null when the market row has not loaded yet — not the same as missing. */
  marketLoaded: boolean;
  quoteClosed: boolean;
}

export function carrierBlockers(input: CarrierReadinessInput): ReadinessBlocker[] {
  const blockers: ReadinessBlocker[] = [];

  if (input.quoteClosed) {
    blockers.push({
      code: 'quote_closed',
      message: 'This quote is closed.',
      remedy: 'Reopen it before sending anything further.',
      managerFixable: false,
    });
  }

  if (!input.marketLinked) {
    blockers.push({
      code: 'carrier_not_linked',
      message: 'This carrier is not linked to a Market Directory entry.',
      remedy:
        'A manager can link it under User Administration → Market Directory. Until then it has no submission address.',
      managerFixable: true,
    });
    // Without a market there is nothing to say about its email settings.
    return blockers;
  }

  // A market that has not loaded yet is unknown, not misconfigured. Claiming a carrier is
  // broken while its configuration is still in flight would be a lie that clears itself.
  if (!input.marketLoaded) return blockers;

  if (!input.emailSubmissionEnabled) {
    blockers.push({
      code: 'email_submission_disabled',
      message: 'Email submission is turned off for this carrier.',
      remedy: 'A manager can enable it on the carrier’s Submission tab.',
      managerFixable: true,
    });
  }

  if ((input.submissionEmail ?? '').trim().length === 0) {
    blockers.push({
      code: 'submission_email_missing',
      message: 'This carrier has no submission email address.',
      remedy: 'A manager can set it on the carrier’s Submission tab.',
      managerFixable: true,
    });
  }

  return blockers;
}

/** The one-line status a carrier card shows. */
export function readinessSummary(blockers: readonly ReadinessBlocker[]): string {
  if (blockers.length === 0) return 'Ready to submit';
  if (blockers.length === 1) return blockers[0].message;
  return `${blockers.length} things to sort out first`;
}
