// src/app/api/payroll/calculate/route.ts
// GET /api/payroll/calculate?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD
//
// The per-employee figures a payroll period is calculated from, for review in
// PayrollProcessor before `/api/payroll/process` persists them.
//
// ## What changed and what did not
//
// The arithmetic used to live here: this route read profiles, pay settings,
// clock entries, and approved absences, then summed hours, capped overtime,
// applied deductions, and rounded, inline. It now reads all of that from
// `payrollInputs(period, 'legacy_parity', ...)`, which is the same arithmetic
// transcribed into the Attendance_Service and covered by the parity harness
// (`scripts/verify-payroll-parity.mjs`) and Property 47.
//
// The response is unchanged: the same nineteen snake_case fields in the same
// order, carrying the same values with the same rounding boundaries, wrapped in
// the same `{ summaries, period_start, period_end }` envelope. `legacy_parity`
// preserves the pre-redesign behaviour bug for bug — closed entries only, whole
// `total_days` for every overlapping approved request, the period-average
// overtime cap, two decimals at each stage — so no cent of anybody's pay moves
// (Requirement 2, criteria 4 and 6). Adopting the service's `recomputed` mode
// would move figures for unchanged input and is reserved for a separately
// approved payroll rule change.
//
// Two visible differences, neither of them a figure:
//
//   1. A period that is not a calendar range is now refused as an invalid
//      request. It used to be fed straight into the arithmetic and answered 200
//      with `NaN` in every money field.
//   2. Rows arrive ordered by display name. They used to arrive in whatever
//      order Postgres chose, which was not stable between calls.
//
// The zero-active-employee path used to answer `{ summaries: [] }` without the
// two period echoes. It now answers with them, so the envelope is one shape
// whatever the roster. The summary set is empty either way.
//
// ## What stays in the route
//
// `payrollInputs` performs no authorisation and takes no `Actor`: payroll is
// calculated over the whole active roster and the figures are reserved to an
// Attendance_Administrator. The super-admin gate and the
// overlapping-processed-period refusal therefore stay here, ahead of the call,
// and the caller's own cookie-bound client is passed in so every read still runs
// under the caller's row level security.
//
// Requirements: 2.4 (identical payroll output), 2.6 (any output change is a
// separately approved rule change), 19.6 (payroll consumes worked hours, break
// minutes, and absence days from the Attendance_Service).

import { serviceFailure } from "@/features/time-attendance/server/api-response";
import {
  payrollInputs,
  type PayrollInputRow,
} from "@/features/time-attendance/server/attendance-service";
import { canAdministerAttendance } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * One employee's figures in the response's own casing.
 *
 * Key order is the pre-redesign object's, field for field, so the serialised
 * body is unchanged. Every value is read off `PayrollInputRow`; nothing is
 * recomputed or re-rounded here.
 */
function toSummary(row: PayrollInputRow) {
  return {
    profile_id: row.profileId,
    display_name: row.displayName,
    initials: row.initials,
    role: row.role,
    hourly_rate: row.hourlyRate,
    regular_hours: row.regularHours,
    overtime_hours: row.overtimeHours,
    break_hours: row.breakHours,
    total_hours: row.totalHours,
    pto_days_used: row.ptoDaysUsed,
    pto_hours_paid: row.ptoHoursPaid,
    regular_pay: row.regularPay,
    overtime_pay: row.overtimePay,
    pto_pay: row.ptoPay,
    gross_pay: row.grossPay,
    deductions_total: row.deductionsTotal,
    net_pay: row.netPay,
    days_worked: row.daysWorked,
    entries_count: row.entriesCount,
  };
}

export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!canAdministerAttendance(profile?.role)) {
    return Response.json({ error: "Only super admins can calculate payroll." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const periodStart = searchParams.get("period_start");
  const periodEnd = searchParams.get("period_end");

  if (!periodStart || !periodEnd) {
    return Response.json({ error: "period_start and period_end are required." }, { status: 400 });
  }

  // Check for overlapping already-processed periods
  const { data: overlapping } = await supabase
    .from("payroll_periods")
    .select("id, period_start, period_end, status")
    .eq("status", "processed")
    .lte("period_start", periodEnd)
    .gte("period_end", periodStart);

  if (overlapping && overlapping.length > 0) {
    const conflicts = overlapping.map(p => `${p.period_start} to ${p.period_end}`).join(', ');
    return Response.json({
      error: `This period overlaps with already-processed payroll: ${conflicts}. Choose dates that don't overlap with existing periods.`,
      overlapping_periods: overlapping,
    }, { status: 409 });
  }

  try {
    const rows = await payrollInputs(
      { from: periodStart, to: periodEnd },
      "legacy_parity",
      { client: supabase },
    );

    return Response.json({
      summaries: rows.map(toSummary),
      period_start: periodStart,
      period_end: periodEnd,
    });
  } catch (error) {
    return serviceFailure(error);
  }
}
