import { createClient as createSupabaseAdmin } from '@supabase/supabase-js';

import {
  isRingCentralConfigured,
  sendSms,
  buildRenewalReminderMessage,
  type RenewalReminderTier,
} from '@/lib/ringcentral-sms';

export const runtime = 'nodejs';

/**
 * POST /api/renewals/sms/scheduler — Automated renewal SMS reminder cron
 *
 * Sends texts to open renewals at 30-day, 15-day, and 7-day milestones.
 * Skips records that already received the milestone text (unique index dedup).
 * Designed to be called by Vercel Cron or a manual manager trigger.
 *
 * Headers: Authorization: Bearer <CRON_SECRET> (or authenticated session)
 *
 * Returns: { success, summary: { total, sent, skipped, failed } }
 */
export async function POST(request: Request) {
  // ---- Authorization (cron secret or authenticated manager) ----
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  let isAuthorizedCron = false;
  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    isAuthorizedCron = true;
  }

  // If not a cron call, require manager auth
  if (!isAuthorizedCron) {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();
    if (!supabase) {
      return Response.json({ error: 'Supabase is not configured.' }, { status: 503 });
    }
    const { data: userData } = await supabase.auth.getUser();
    if (!userData?.user) {
      return Response.json({ error: 'Authentication required.' }, { status: 401 });
    }
    // Check role
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userData.user.id)
      .single();
    if (!profile || (profile.role !== 'manager' && profile.role !== 'super_admin')) {
      return Response.json({ error: 'Manager permission required.' }, { status: 403 });
    }
  }

  // ---- Validate RC config ----
  if (!isRingCentralConfigured()) {
    return Response.json(
      { error: 'RingCentral SMS is not configured.' },
      { status: 503 },
    );
  }

  // ---- Service-role Supabase client (bypasses RLS for batch operations) ----
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) {
    return Response.json({ error: 'Server database credentials not configured.' }, { status: 503 });
  }
  const admin = createSupabaseAdmin(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- Find eligible renewals ----
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const milestones: Array<{ tier: RenewalReminderTier; daysOut: number }> = [
    { tier: 'auto_30d', daysOut: 30 },
    { tier: 'auto_15d', daysOut: 15 },
    { tier: 'auto_7d', daysOut: 7 },
  ];

  const openStatuses = ['imported', 'assigned', 'in_progress', 'monitoring', 'requote_sent'];
  const summary = { total: 0, sent: 0, skipped: 0, failed: 0 };

  for (const milestone of milestones) {
    // Calculate target date (renewals that are exactly N days or fewer away, but not past)
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() + milestone.daysOut);
    const targetDateStr = targetDate.toISOString().slice(0, 10);

    // Find open renewals with phone, due within this milestone window,
    // that haven't already received this tier's text
    const { data: renewals, error: queryError } = await admin
      .from('renewal_records')
      .select('id, customer_name, customer_phone, carrier, policy_number, renewal_date')
      .in('status', openStatuses)
      .not('customer_phone', 'is', null)
      .lte('renewal_date', targetDateStr)
      .gte('renewal_date', today.toISOString().slice(0, 10));

    if (queryError) {
      console.error(`Scheduler query error for ${milestone.tier}:`, queryError.message);
      continue;
    }

    if (!renewals || renewals.length === 0) continue;

    for (const record of renewals) {
      summary.total++;

      // Check if already sent for this milestone (dedup without relying solely on unique index)
      const { data: existing } = await admin
        .from('renewal_sms_log')
        .select('id')
        .eq('record_id', record.id)
        .eq('trigger_type', milestone.tier)
        .limit(1);

      if (existing && existing.length > 0) {
        summary.skipped++;
        continue;
      }

      // Send SMS
      const text = buildRenewalReminderMessage({
        customerName: record.customer_name,
        carrier: record.carrier,
        policyNumber: record.policy_number,
        renewalDate: record.renewal_date,
      });

      const result = await sendSms(record.customer_phone!, text);

      // Log result
      const { error: insertError } = await admin.from('renewal_sms_log').insert({
        record_id: record.id,
        phone: record.customer_phone,
        message_text: text,
        trigger_type: milestone.tier,
        rc_message_id: result.messageId || null,
        delivery_status: result.success ? 'sent' : 'failed',
        error_detail: result.error || null,
        sent_by: null, // automated — no user
      });

      if (insertError) {
        // Likely unique constraint violation (race condition) — count as skipped
        if (insertError.code === '23505') {
          summary.skipped++;
        } else {
          console.error(`SMS log insert error for record ${record.id}:`, insertError.message);
          summary.failed++;
        }
        continue;
      }

      if (result.success) {
        summary.sent++;
      } else {
        summary.failed++;
      }

      // Rate limiting: small delay between sends (1 msg/sec RC limit)
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }

  return Response.json({ success: true, summary });
}
