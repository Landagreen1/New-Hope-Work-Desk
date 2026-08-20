/**
 * Is the feature configured? Presence booleans only, never values.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirement 12.
 *
 * This exists for the same reason `src/features/cancellations/scheduler/readiness.ts`
 * does. That module's comment records the bug it was born from: a readiness route had
 * hand-copied the provider's environment variable names, got them wrong, and reported
 * "not configured" forever without anything failing.
 *
 * So the rule is: only the owning module names a credential, and everyone else asks it.
 * The route imports this; it does not import the provider.
 */

import { isEncryptionConfigured } from '@/lib/crypto/secret-box';
import { isMicrosoftConfigured } from '@/lib/microsoft-mail';

export interface SubmissionReadiness {
  /** OAuth client, secret, tenant and redirect are all present. */
  provider: boolean;
  /** A usable 32-byte encryption key is present. */
  encryption: boolean;
  /** Both, which is what the UI needs to know before offering Connect. */
  ready: boolean;
}

export function submissionReadiness(): SubmissionReadiness {
  const provider = isMicrosoftConfigured();
  const encryption = isEncryptionConfigured();
  return { provider, encryption, ready: provider && encryption };
}
