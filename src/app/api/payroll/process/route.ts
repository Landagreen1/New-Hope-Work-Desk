import { canAdministerAttendance } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/payroll/process
 * 
 * Processes payroll: creates the payroll_period, saves summaries, locks the period.
 * Super admin only.
 * 
 * Body: {
 *   period_start: string (YYYY-MM-DD),
 *   period_end: string (YYYY-MM-DD),
 *   pay_date: string (YYYY-MM-DD),
 *   summaries: Array<{ profile_id, regular_hours, overtime_hours, break_hours, total_hours,
 *     pto_days_used, pto_hours_paid, regular_pay, overtime_pay, pto_pay, gross_pay,
 *     deductions_total, net_pay, days_worked }>
 * }
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!canAdministerAttendance(profile?.role)) {
    return Response.json({ error: "Only super admins can process payroll." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const periodStart = String(body.period_start ?? "");
  const periodEnd = String(body.period_end ?? "");
  const payDate = String(body.pay_date ?? "");
  const summaries = body.summaries as Array<Record<string, unknown>> | undefined;

  if (!periodStart || !periodEnd || !payDate) {
    return Response.json({ error: "period_start, period_end, and pay_date are required." }, { status: 400 });
  }

  if (!summaries?.length) {
    return Response.json({ error: "No summaries to process." }, { status: 400 });
  }

  // Check for existing period with same dates
  const { data: existing } = await supabase
    .from("payroll_periods")
    .select("id, status")
    .eq("period_start", periodStart)
    .eq("period_end", periodEnd)
    .maybeSingle();

  if (existing && existing.status === "processed") {
    return Response.json({ error: "This period has already been processed." }, { status: 409 });
  }

  // Create or update the payroll period
  let periodId: string;

  if (existing) {
    // Update existing period
    const { error } = await supabase
      .from("payroll_periods")
      .update({
        pay_date: payDate,
        status: "processed",
        processed_by: user.id,
        processed_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (error) return Response.json({ error: error.message }, { status: 400 });
    periodId = existing.id;

    // Delete old summaries for this period (re-processing)
    await supabase.from("payroll_summaries").delete().eq("payroll_period_id", periodId);
  } else {
    // Create new period
    const { data: newPeriod, error } = await supabase
      .from("payroll_periods")
      .insert({
        period_start: periodStart,
        period_end: periodEnd,
        pay_date: payDate,
        payment_template: "biweekly",
        status: "processed",
        processed_by: user.id,
        processed_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error) return Response.json({ error: error.message }, { status: 400 });
    periodId = newPeriod.id;
  }

  // Insert payroll summaries
  const summaryRows = summaries.map((s) => ({
    payroll_period_id: periodId,
    profile_id: s.profile_id,
    regular_hours: s.regular_hours ?? 0,
    overtime_hours: s.overtime_hours ?? 0,
    break_hours: s.break_hours ?? 0,
    total_hours: s.total_hours ?? 0,
    pto_days_used: s.pto_days_used ?? 0,
    pto_hours_paid: s.pto_hours_paid ?? 0,
    regular_pay: s.regular_pay ?? 0,
    overtime_pay: s.overtime_pay ?? 0,
    pto_pay: s.pto_pay ?? 0,
    gross_pay: s.gross_pay ?? 0,
    deductions_total: s.deductions_total ?? 0,
    net_pay: s.net_pay ?? 0,
    days_worked: s.days_worked ?? 0,
    days_absent: 0,
    days_late: 0,
    status: "confirmed",
  }));

  const { error: insertError } = await supabase
    .from("payroll_summaries")
    .insert(summaryRows);

  if (insertError) return Response.json({ error: insertError.message }, { status: 400 });

  // Audit log
  await supabase.from("audit_log").insert({
    actor_profile_id: user.id,
    action: "payroll_processed",
    entity_type: "payroll_period",
    entity_id: periodId,
    new_value: {
      period_start: periodStart,
      period_end: periodEnd,
      pay_date: payDate,
      employee_count: summaries.length,
      total_gross: summaries.reduce((sum, s) => sum + Number(s.gross_pay ?? 0), 0),
    },
  });

  return Response.json({
    success: true,
    period_id: periodId,
    processed_count: summaries.length,
  });
}
