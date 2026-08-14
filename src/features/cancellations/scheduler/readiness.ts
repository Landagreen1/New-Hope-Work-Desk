// Provider readiness for the deployment checklist (REQ-3.2, REQ-3.3).
//
// One question, asked in one place: can this deployment actually send on each channel?
//
// ── WHY THIS MODULE EXISTS AT ALL
//
// `POST /api/cancellations/readiness` answered it by reading environment variables itself, and got
// both channels wrong:
//
//   * **SMS was permanently false.** It read `RINGCENTRAL_JWT_TOKEN`, `RINGCENTRAL_CLIENT_ID`, and
//     `RINGCENTRAL_CLIENT_SECRET`. The variables this product actually uses are `RC_JWT_TOKEN`,
//     `RC_CLIENT_ID`, and `RC_CLIENT_SECRET` — the names `src/lib/ringcentral-sms.ts` reads and
//     `.env.example` documents. No deployment could ever satisfy the check, and the readiness panel
//     gates the automatic-sending toggle on every check passing, so automatic sending could not be
//     turned on however well configured the deployment was.
//
//   * **Email was weaker than the send path.** It checked the API key alone, while
//     `isEmailConfigured()` requires the key *and* the from-address. So the panel could show a green
//     tick while every send failed on an absent from-address.
//
// Both were the same mistake: a second, hand-written copy of a question the provider modules already
// answer. This module deletes the copy. `isRingCentralConfigured` and `isEmailConfigured` are the
// definitions, and the readiness surface now reports exactly what the send path will do.
//
// ── WHY THE ROUTE CANNOT DO THIS ITSELF
//
// Requirements 23.1 and 23.5 confine each provider to one module, and `provider-isolation.test.ts`
// enforces two rules that together make the route the wrong place:
//
//   1. the credential names and provider endpoints may not appear outside the provider module, which
//      is why the old route resorted to `['RESEND','API','KEY'].join('_')` to dodge the scanner; and
//   2. no route under `src/app/api/cancellations/` may import `@/lib/email` or
//      `@/lib/ringcentral-sms`.
//
// The features layer may import both — `scheduler/send.ts` and `scheduler/run.ts` already do — so
// the check belongs here and the route delegates. That keeps the isolation intact while removing the
// string-join workaround that hid the bug in the first place.

import { isEmailConfigured } from '@/lib/email';
import { isRingCentralConfigured } from '@/lib/ringcentral-sms';

/** Whether each outbound channel is configured well enough to send. */
export interface ProviderReadiness {
  /**
   * True when RingCentral holds the credentials `src/lib/ringcentral-sms.ts` needs. The same
   * predicate that module applies before it will build an SDK client.
   */
  sms: boolean;
  /**
   * True when both the provider credential and the single agency from-address are present — the same
   * predicate `sendEmail` applies before it will call the provider, so a green tick here means a
   * send will not be refused for configuration.
   */
  email: boolean;
}

/**
 * Whether each channel can send, answered by the provider modules themselves.
 *
 * Presence of credentials only. Neither predicate contacts a provider, so this is safe to call on
 * every readiness poll, and no credential value is read into the result. A key that is present but
 * revoked still reports `true` here — that is a question only a real send can answer, which is what
 * the test-email action in `./test-email.ts` is for.
 */
export function providerReadiness(): ProviderReadiness {
  return {
    sms: isRingCentralConfigured(),
    email: isEmailConfigured(),
  };
}
