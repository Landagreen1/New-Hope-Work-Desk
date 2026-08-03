// POST /api/cancellations/send — the drawer's `Send Reminder Now` and `Retry Failed Communication`.
//
// Called from the cancellation detail drawer, never by cron. Requirement 17.5 sends the current
// Touchpoint's message to every valid, authorized, unsuppressed Contact_Recipient of one case and
// reports the sent, skipped, and failed counts; Requirement 17.6 re-sends only the rows that failed
// for the current Touchpoint and channel, updating the stored row through
// `cancellation_retry_communication` rather than storing a second one, and appends one retry entry
// per Contact_Recipient and channel to the audit timeline.
//
// Authorization is a session read: `Send Reminder Now` is available to every Policy Follow-up role
// on a case assigned to that profile, and to Manager_Role on any case; `Retry Failed Communication`
// is Manager_Role only, with `super_admin` accepted wherever `manager` is (Requirements 17.10, 22.2,
// 22.6, 22.12). Every refusal is answered before a Supabase client exists, so it writes zero rows
// and makes zero provider calls. There is deliberately **no** cron-secret path here: this endpoint
// acts as a named employee on a named case, and a shared secret carries neither.
//
// Both actions work while the Requirement 26.4 kill switch is off (Requirement 26.6): the settings
// row is read for its render constants and `automatic_sending_enabled` is reported in the summary,
// never consulted as a gate.
//
// The work lives in `src/features/cancellations/scheduler/manual-send.ts`, the reserve-then-send in
// `../scheduler/send.ts`, and the session read and service-role client in `../scheduler/authorize.ts`
// — the same split `POST /api/cancellations/scheduler` uses, which is what lets task 15.2 drive both
// actions and every refusal without a running Next server.
//
// Requirements: 17.5, 17.6, 17.11, 17.12, 21.3, 21.4, 22.2, 22.6, 26.6

import { handleManualSendRequest } from '@/features/cancellations/scheduler/manual-send';

export const runtime = 'nodejs';

/** An email retry waits 5 to 60 seconds between attempts, so the default budget is too short. */
export const maxDuration = 300;

/** Never prerendered and never cached: the action reads the clock and writes rows. */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleManualSendRequest(request);
}
