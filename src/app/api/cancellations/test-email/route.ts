// POST /api/cancellations/test-email — the readiness panel's email configuration test.
//
// Manager-only. Sends one message to an address the manager types, and reports the provider's own
// response so a failure names its cause: an invalid credential, an unverified sending domain, and a
// from-address the key may not use are different problems with different fixes.
//
// The recipient never comes from the database, so this cannot reach a customer contact. Nothing is
// written: no Communication_Record, no test-send row, no case status change.
//
// The work lives in `src/features/cancellations/scheduler/test-email.ts`, and this route only
// delegates — the same split `POST /api/cancellations/send` uses. That is not stylistic:
// Requirements 23.1 and 23.5 confine the email provider to `src/lib/email.ts`, and
// `provider-isolation.test.ts` forbids any route under this directory from importing it.
//
// Requirements: 3.4, 22.6, 23.1, 23.5

import { handleTestEmailRequest } from '@/features/cancellations/scheduler/test-email';

export const runtime = 'nodejs';

/** One provider call with a 30-second timeout inside `sendEmail`; the default budget is enough. */
export const maxDuration = 60;

/** Never prerendered and never cached: the action calls a provider. */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleTestEmailRequest(request);
}
