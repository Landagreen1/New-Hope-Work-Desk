/**
 * GET    — this user's mailbox connection status.
 * DELETE — disconnect, destroying the credentials and keeping the history.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirement 1.
 */

import { MESSAGES, fail, ok } from '@/features/carrier-submissions/server/api';
import { resolveSubmissionActor } from '@/features/carrier-submissions/server/actor';
import { deleteConnection, readConnection } from '@/features/carrier-submissions/server/connections';
import { submissionReadiness } from '@/features/carrier-submissions/server/readiness';
import { createSubmissionServiceClient } from '@/features/carrier-submissions/server/service-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const resolved = await resolveSubmissionActor();
  if (!resolved.ok) return resolved.response;

  const connection = await readConnection(resolved.client, resolved.actor.id);

  return ok({
    // Reported so the settings screen can say "ask an administrator to finish setup"
    // rather than offering a Connect button that cannot possibly work.
    configured: submissionReadiness().ready,
    can_send: resolved.actor.canSend,
    connection,
  });
}

export async function DELETE() {
  const resolved = await resolveSubmissionActor();
  if (!resolved.ok) return resolved.response;

  const service = createSubmissionServiceClient();
  if (!service) return fail('unconfigured', MESSAGES.unconfigured);

  // Scoped to the caller's own profile id, never to a value from the request. There is no
  // route by which one user can disconnect another's mailbox.
  const deleted = await deleteConnection(service, resolved.actor.id);
  if (!deleted) return fail('write_failed', 'Could not disconnect the mailbox.');

  return ok({ disconnected: true });
}
