// src/features/time-attendance/shared/queue-status-client.ts
// The one browser-side call that changes an employee's own sales-queue status.
//
// Spec: .kiro/specs/attendance-queue-status-separation, task 7.2
// Requirements: 2.9, 2.12, 2.15, 2.17, 3.10
//
// `set_my_queue_status` wraps `apply_queue_status`, which wraps the existing
// `set_my_availability` — so the rotation handoff, the recovery and the
// `turn_events` rows are unchanged, and the addition is the one `manual_agent`
// availability event that makes the change attributable.
//
// The RPC result is inspected. That is the whole point of the fix: the routes
// used to discard `{ error }` from exactly this call and report success anyway.

'use client';

import { createClient } from '@/lib/supabase/client';

import type { QueueStatusValue } from '../domain/queue-status';

/**
 * Set the signed-in employee's own sales-queue status.
 *
 * Resolves with the status the database reports after the change, which is not
 * necessarily the status asked for — `apply_queue_status` returns the value it
 * read back. Rejects with the message Postgres raised, for the caller to display.
 */
export async function setMyQueueStatus(
  status: QueueStatusValue,
  reason?: string,
): Promise<QueueStatusValue> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('set_my_queue_status', {
    p_status: status,
    p_reason: reason ?? null,
  });

  if (error) throw new Error(error.message);

  return (data as QueueStatusValue | null) ?? status;
}
