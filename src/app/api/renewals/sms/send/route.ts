import { createClient } from '@/lib/supabase/server';
import { isRingCentralConfigured, sendSms, buildRenewalReminderMessage } from '@/lib/ringcentral-sms';

export const runtime = 'nodejs';

/**
 * POST /api/renewals/sms/send — Send a manual SMS for a renewal record
 *
 * Body: { recordId: string, message?: string }
 *   - recordId: the renewal_records.id to send for
 *   - message: optional custom message (uses template if omitted)
 *
 * Returns: { success, smsLogId, messageId, error }
 */
export async function POST(request: Request) {
  // ---- Auth ----
  const supabase = await createClient();
  if (!supabase) {
    return Response.json({ error: 'Supabase is not configured.' }, { status: 503 });
  }

  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return Response.json({ error: 'Authentication required.' }, { status: 401 });
  }

  // ---- Validate RC config ----
  if (!isRingCentralConfigured()) {
    return Response.json(
      { error: 'RingCentral SMS is not configured. Contact your administrator.' },
      { status: 503 },
    );
  }

  // ---- Parse body ----
  let body: { recordId?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { recordId, message } = body;
  if (!recordId) {
    return Response.json({ error: 'recordId is required.' }, { status: 400 });
  }

  // ---- Fetch renewal record ----
  const { data: record, error: recordError } = await supabase
    .from('renewal_records')
    .select('id, customer_name, customer_phone, carrier, policy_number, renewal_date, status')
    .eq('id', recordId)
    .single();

  if (recordError || !record) {
    return Response.json({ error: 'Renewal record not found.' }, { status: 404 });
  }

  if (!record.customer_phone) {
    return Response.json(
      { error: 'This renewal record has no phone number. Add one before sending a text.' },
      { status: 422 },
    );
  }

  // ---- Build message ----
  const text = message?.trim() || buildRenewalReminderMessage({
    customerName: record.customer_name,
    carrier: record.carrier,
    policyNumber: record.policy_number,
    renewalDate: record.renewal_date,
  });

  // ---- Send via RingCentral ----
  const result = await sendSms(record.customer_phone, text);

  // ---- Log to database ----
  const { data: logEntry, error: logError } = await supabase
    .from('renewal_sms_log')
    .insert({
      record_id: recordId,
      phone: record.customer_phone,
      message_text: text,
      trigger_type: 'manual',
      rc_message_id: result.messageId || null,
      delivery_status: result.success ? 'sent' : 'failed',
      error_detail: result.error || null,
      sent_by: userData.user.id,
    })
    .select('id')
    .single();

  if (logError) {
    // SMS was sent but logging failed — still report success to user
    console.error('Failed to log SMS send:', logError.message);
  }

  if (!result.success) {
    return Response.json(
      { error: `SMS failed: ${result.error}`, smsLogId: logEntry?.id },
      { status: 502 },
    );
  }

  return Response.json({
    success: true,
    smsLogId: logEntry?.id,
    messageId: result.messageId,
    messageStatus: result.messageStatus,
  });
}
