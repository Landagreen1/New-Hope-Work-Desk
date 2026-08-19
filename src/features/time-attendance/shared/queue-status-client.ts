// src/features/time-attendance/shared/queue-status-client.ts
// The one browser-side call that changes an employee's own sales-queue status.
//
// v1.19.0: Now uses `set_my_queue_status_v2` which routes through the centralized
// `transition_agent_queue_status()` gateway. Supports optimistic concurrency
// via version checking. The old `set_my_queue_status` RPC is a compatibility
// wrapper that delegates to the same system.

'use client';

import { createClient } from '@/lib/supabase/client';

import type { QueueStatusValue } from '../domain/queue-status';

/**
 * Response shape from the v2 queue status RPC.
 */
export interface QueueStatusResponse {
  success: boolean;
  changed?: boolean;
  profile_id: string;
  previous_status?: QueueStatusValue;
  status: QueueStatusValue;
  previous_version?: number;
  version: number;
  source?: string;
  /** Present only when success=false */
  reason?: string;
  current_status?: QueueStatusValue;
  current_version?: number;
}

/**
 * Set the signed-in employee's own sales-queue status.
 *
 * Uses the v2 RPC which returns a structured JSONB response with version
 * information. Rejects with a descriptive error message on failure.
 *
 * @param status - The target queue status
 * @param reason - Optional reason for the change
 * @param expectedVersion - Optional version for optimistic concurrency
 */
export async function setMyQueueStatus(
  status: QueueStatusValue,
  reason?: string,
  expectedVersion?: number | null,
): Promise<QueueStatusValue> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('set_my_queue_status_v2', {
    p_status: status,
    p_reason: reason ?? null,
    p_expected_version: expectedVersion ?? null,
  });

  if (error) throw new Error(error.message);

  const result = data as QueueStatusResponse | null;

  if (result && !result.success) {
    if (result.reason === 'STALE_QUEUE_STATE') {
      throw new Error(
        `Status was already changed to ${result.current_status}. Please try again.`,
      );
    }
    throw new Error(result.reason || 'Queue status change failed.');
  }

  return result?.status ?? status;
}

/**
 * Set the signed-in employee's own sales-queue status (v2 with full response).
 *
 * Returns the complete transition result including version for callers that
 * need optimistic concurrency information.
 */
export async function setMyQueueStatusV2(
  status: QueueStatusValue,
  reason?: string,
  expectedVersion?: number | null,
): Promise<QueueStatusResponse> {
  const supabase = createClient();

  const { data, error } = await supabase.rpc('set_my_queue_status_v2', {
    p_status: status,
    p_reason: reason ?? null,
    p_expected_version: expectedVersion ?? null,
  });

  if (error) throw new Error(error.message);

  const result = data as QueueStatusResponse | null;
  if (!result) throw new Error('No response from queue status RPC');

  return result;
}
