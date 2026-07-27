import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/payroll/calculate?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD
 * 
 * Calculates payroll for all employees for the given period.
 * Reads time_clock_entries and employee_payment_settings, computes:
 * - Regular hours, overtime hours, break hours
 * - Gross pay, deductions, net pay
 * 
 * Super admin only.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "super_admin") {
    return Response.json({ error: "Only super admins can calculate payroll." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const periodStart = searchParams.get("period_start");
  const periodEnd = searchParams.get("period_end");

  if (!periodStart || !periodEnd) {
    return Response.json({ error: "period_start and period_end are required." }, { status: 400 });
  }

  // Get all active employees with payment settings
  const { data: employees } = await supabase
    .from("profiles")
    .select("id, display_name, initials, role, is_active")
    .eq("is_active", true);

  if (!employees?.length) {
    return Response.json({ summaries: [] });
  }

  // Get all payment settings
  const { data: allSettings } = await supabase
    .from("employee_payment_settings")
    .select("*");

  const settingsMap = new Map<string, Record<string, unknown>>();
  for (const s of allSettings ?? []) {
    settingsMap.set(s.profile_id, s);
  }

  // Get all clock entries in the period
  const { data: clockEntries } = await supabase
    .from("time_clock_entries")
    .select("*")
    .gte("clock_in", `${periodStart}T00:00:00`)
    .lte("clock_in", `${periodEnd}T23:59:59`)
    .not("clock_out", "is", null);

  // Get approved PTO in the period
  const { data: ptoRequests } = await supabase
    .from("pto_requests")
    .select("*")
    .eq("status", "approved")
    .lte("start_date", periodEnd)
    .gte("end_date", periodStart);

  // Group clock entries by profile
  const entriesByProfile = new Map<string, Array<Record<string, unknown>>>();
  for (const entry of clockEntries ?? []) {
    const list = entriesByProfile.get(entry.profile_id) ?? [];
    list.push(entry);
    entriesByProfile.set(entry.profile_id, list);
  }

  // Group PTO by profile
  const ptoByProfile = new Map<string, number>();
  for (const pto of ptoRequests ?? []) {
    const current = ptoByProfile.get(pto.profile_id) ?? 0;
    ptoByProfile.set(pto.profile_id, current + Number(pto.total_days ?? 0));
  }

  // Calculate per-employee summaries
  const summaries = employees.map((emp) => {
    const settings = settingsMap.get(emp.id) as Record<string, unknown> | undefined;
    const hourlyRate = Number(settings?.hourly_rate ?? 0);
    const overtimeMultiplier = Number(settings?.overtime_multiplier ?? 1.5);
    const weeklyOtThreshold = Number(settings?.weekly_overtime_threshold ?? 40);
    const deductions = (settings?.deductions ?? []) as Array<{ label: string; amount: number; type: string }>;

    const entries = entriesByProfile.get(emp.id) ?? [];
    const ptoDays = ptoByProfile.get(emp.id) ?? 0;

    // Calculate hours from entries
    let totalWorkedHours = 0;
    let totalBreakHours = 0;
    let daysWorked = new Set<string>();

    for (const entry of entries) {
      const hours = Number(entry.total_hours ?? 0);
      const breakMin = Number(entry.break_minutes ?? 0);
      totalWorkedHours += hours;
      totalBreakHours += breakMin / 60;
      // Track unique days
      const dayKey = new Date(entry.clock_in as string).toISOString().split("T")[0];
      daysWorked.add(dayKey);
    }

    // Calculate overtime: hours over the weekly threshold
    // Simple approach: total hours in period vs (weeks * threshold)
    const periodDays = Math.round((new Date(periodEnd).getTime() - new Date(periodStart).getTime()) / 86400000) + 1;
    const weeks = periodDays / 7;
    const regularCap = weeks * weeklyOtThreshold;
    const regularHours = Math.min(totalWorkedHours, regularCap);
    const overtimeHours = Math.max(0, totalWorkedHours - regularCap);

    // PTO pay (8 hours per day at hourly rate)
    const ptoHoursPaid = ptoDays * 8;
    const ptoPay = ptoHoursPaid * hourlyRate;

    // Pay calculations
    const regularPay = regularHours * hourlyRate;
    const overtimePay = overtimeHours * hourlyRate * overtimeMultiplier;
    const grossPay = regularPay + overtimePay + ptoPay;

    // Deductions
    let deductionsTotal = 0;
    for (const d of deductions) {
      if (d.type === "percentage") {
        deductionsTotal += grossPay * (d.amount / 100);
      } else {
        deductionsTotal += d.amount;
      }
    }
    deductionsTotal = Math.round(deductionsTotal * 100) / 100;

    const netPay = Math.round((grossPay - deductionsTotal) * 100) / 100;

    return {
      profile_id: emp.id,
      display_name: emp.display_name,
      initials: emp.initials,
      role: emp.role,
      hourly_rate: hourlyRate,
      regular_hours: Math.round(regularHours * 100) / 100,
      overtime_hours: Math.round(overtimeHours * 100) / 100,
      break_hours: Math.round(totalBreakHours * 100) / 100,
      total_hours: Math.round(totalWorkedHours * 100) / 100,
      pto_days_used: ptoDays,
      pto_hours_paid: ptoHoursPaid,
      regular_pay: Math.round(regularPay * 100) / 100,
      overtime_pay: Math.round(overtimePay * 100) / 100,
      pto_pay: Math.round(ptoPay * 100) / 100,
      gross_pay: Math.round(grossPay * 100) / 100,
      deductions_total: deductionsTotal,
      net_pay: netPay,
      days_worked: daysWorked.size,
      entries_count: entries.length,
    };
  }).filter(s => s.total_hours > 0 || s.pto_days_used > 0); // Only include employees with activity

  return Response.json({ summaries, period_start: periodStart, period_end: periodEnd });
}
