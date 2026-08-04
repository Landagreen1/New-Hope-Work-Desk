// Test-send mode: sends only to a manager-provided test recipient (REQ-3.4).
//
// Never writes to cancellation_communications or cancellation_communication_cases.
// Records the test in cancellation_test_sends for audit purposes.
// Never replaces a customer contact or creates a customer delivery record.

import type { SupabaseClient } from '@supabase/supabase-js';

import { isEmailConfigured, sendEmail } from '@/lib/email';
import { sendSms } from '@/lib/ringcentral-sms';

import type { Touchpoint } from '../render/renderMessage';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestSendInput {
  /** The Supabase service-role client. */
  client: SupabaseClient;
  /** The case to render the test message for. */
  caseId: string;
  /** Which touchpoint to render. */
  touchpoint: Touchpoint;
  /** The channel to send through. */
  channel: 'sms' | 'email';
  /** The test recipient (never a customer contact). */
  recipient: string;
  /** The actor performing the test send. */
  actorId: string;
  /** Optional rendered subject (if pre-rendered). */
  renderedSubject?: string;
  /** The rendered body text to send. */
  renderedBody: string;
}

export interface TestSendResult {
  ok: boolean;
  /** The test_sends row id if recorded. */
  testSendId: string | null;
  /** Provider message id on success. */
  providerMessageId: string | null;
  /** Failure reason on error. */
  failureReason: string | null;
  /** Delivery result. */
  deliveryResult: 'Sent' | 'Failed';
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Sends a test message to the provided recipient and records it in cancellation_test_sends.
 *
 * This function:
 * - Sends to the test recipient ONLY (never to customer contacts)
 * - Records in cancellation_test_sends (NOT cancellation_communications)
 * - Does not create any Communication_Record that would affect the case's status
 */
export async function runTestSend(input: TestSendInput): Promise<TestSendResult> {
  const {
    client,
    caseId,
    touchpoint,
    channel,
    recipient,
    actorId,
    renderedSubject,
    renderedBody,
  } = input;

  let providerMessageId: string | null = null;
  let failureReason: string | null = null;
  let deliveryResult: 'Sent' | 'Failed' = 'Failed';

  try {
    if (channel === 'sms') {
      const result = await sendSms(recipient, renderedBody);
      if (result.success) {
        deliveryResult = 'Sent';
        providerMessageId = result.messageId ?? null;
      } else {
        failureReason = result.error ?? 'SMS send failed';
      }
    } else {
      if (!isEmailConfigured()) {
        failureReason = 'Email is not configured. Configure the email provider environment variable.';
      } else {
        const result = await sendEmail({
          to: recipient,
          subject: renderedSubject ?? 'Test Cancellation Notice',
          body: renderedBody,
          senderDisplayName: 'New Hope Insurance (Test)',
          replyTo: recipient,
        });
        if (result.success) {
          deliveryResult = 'Sent';
          providerMessageId = result.messageId ?? null;
        } else {
          failureReason = result.failureReason ?? 'Email send failed';
        }
      }
    }
  } catch (err) {
    failureReason = err instanceof Error ? err.message : 'Provider call failed';
  }

  // Record in cancellation_test_sends (never in cancellation_communications)
  const { data, error } = await client
    .from('cancellation_test_sends')
    .insert({
      case_id: caseId,
      touchpoint,
      channel,
      recipient,
      rendered_subject: renderedSubject ?? null,
      rendered_body: renderedBody,
      actor_id: actorId,
      delivery_result: deliveryResult,
      provider_message_id: providerMessageId,
      failure_reason: failureReason,
    })
    .select('id')
    .single();

  const testSendId = error ? null : (data as { id: string } | null)?.id ?? null;

  return {
    ok: deliveryResult === 'Sent',
    testSendId,
    providerMessageId,
    failureReason,
    deliveryResult,
  };
}
