import { canAdministerAttendance } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/time-clock/reports
 * Returns attendance analytics for super admin:
 *   - Late arrivals (agents who clocked in after their scheduled shift_start)
 *   - Average break time per employee per day
 *   - Time adherence % (scheduled hours vs actual hours worked, overtime excluded)
 *
 * Query: ?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!canAdministerAttendance(profile?.role)) {
    return Response.json({ error: "Only super admins can view reports." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const periodStart = searchParams.get("period_start");
  const periodEnd = searchParams.get("period_end");

  if (!periodStart || !periodEnd) {
    return Response.json({ error: "period_start and period_end are required." }, { status: 400 });
  }

  // Fetch clock entries with profile info
  const { data: clockEntries, error: clockError } = await supabase
    .from("time_clock_entries")
    .select("id, profile_id, clock_in, clock_out, total_hours, break_minutes, is_overtime, profiles!time_clock_entries_profile_id_fkey(display_name, initials)")
    .gte("clock_in", `${periodStart}T00:00:00`)
    .lte("clock_in", `${periodEnd}T23:59:59`)
    .order("clock_in", { ascending: true });

  if (clockError) return Response.json({ error: clockError.message }, { status: 400 });

  // Fetch schedules for the period
  const { data: schedules, error: schedError } = await supabase
    .from("employee_schedules")
    .select("profile_id, schedule_date, shift_start, shift_end")
    .gte("schedule_date", periodStart)
    .lte("schedule_date", periodEnd);

  if (schedError) return Response.json({ error: schedError.message }, { status: 400 });

  // Fetch break details
  const entryIds = (clockEntries ?? []).map(e => e.id);
  let breaks: Array<{ clock_entry_id: string; duration_minutes: number | null }> = [];
  if (entryIds.length > 0) {
    const { data: breakData } = await supabase
      .from("time_clock_breaks")
      .select("clock_entry_id, duration_minutes")
      .in("clock_entry_id", entryIds);
    breaks = breakData ?? [];
  }

  // ─── Process Analytics ──────────────────────────────────────────────────────

  // Build schedule map: { profileId: { date: { start, end } } }
  const scheduleMap: Record<string, Record<string, { start: string; end: string }>> = {};
  for (const s of schedules ?? []) {
    if (!scheduleMap[s.profile_id]) scheduleMap[s.profile_id] = {};
    scheduleMap[s.profile_id][s.schedule_date] = { start: s.shift_start, end: s.shift_end };
  }

  // Build break map: { entryId: totalBreakMinutes }
  const breakMap: Record<string, number> = {};
  for (const b of breaks) {
    if (b.duration_minutes) {
      breakMap[b.clock_entry_id] = (breakMap[b.clock_entry_id] ?? 0) + b.duration_minutes;
    }
  }

  // Per-employee analytics
  const employeeStats: Record<string, {
    display_name: string;
    initials: string;
    total_entries: number;
    late_count: number;
    late_minutes_total: number;
    break_minutes_total: number;
    break_days: number;
    scheduled_hours: number;
    actual_hours: number; // excluding overtime
    overtime_hours: number;
  }> = {};

  for (const entry of clockEntries ?? []) {
    const pid = entry.profile_id;
    const profileInfo = (Array.isArray(entry.profiles) ? entry.profiles[0] : entry.profiles) as { display_name: string; initials: string } | null;

    if (!employeeStats[pid]) {
      employeeStats[pid] = {
        display_name: profileInfo?.display_name ?? "Unknown",
        initials: profileInfo?.initials ?? "??",
        total_entries: 0,
        late_count: 0,
        late_minutes_total: 0,
        break_minutes_total: 0,
        break_days: 0,
        scheduled_hours: 0,
        actual_hours: 0,
        overtime_hours: 0,
      };
    }

    const stats = employeeStats[pid];
    stats.total_entries++;

    // Get the date of this clock-in
    const clockInDate = entry.clock_in.split("T")[0];
    const schedule = scheduleMap[pid]?.[clockInDate];

    // Check if late
    if (schedule) {
      const scheduledStart = new Date(`${clockInDate}T${schedule.start}`);
      const actualStart = new Date(entry.clock_in);
      const diffMinutes = (actualStart.getTime() - scheduledStart.getTime()) / 60000;

      if (diffMinutes > 5) { // 5-minute grace period
        stats.late_count++;
        stats.late_minutes_total += Math.round(diffMinutes);
      }

      // Scheduled hours for this day
      const schedEnd = new Date(`${clockInDate}T${schedule.end}`);
      const scheduledHrs = (schedEnd.getTime() - scheduledStart.getTime()) / 3600000;
      stats.scheduled_hours += scheduledHrs;
    }

    // Actual hours (exclude overtime from adherence calculation)
    if (entry.total_hours != null) {
      if (entry.is_overtime) {
        stats.overtime_hours += Number(entry.total_hours);
      } else {
        stats.actual_hours += Number(entry.total_hours);
      }
    }

    // Break minutes
    const entryBreak = breakMap[entry.id] ?? entry.break_minutes ?? 0;
    if (entryBreak > 0) {
      stats.break_minutes_total += entryBreak;
      stats.break_days++;
    }
  }

  // Build response
  const employees = Object.entries(employeeStats).map(([profileId, stats]) => {
    const avgBreakMinutes = stats.break_days > 0
      ? Math.round(stats.break_minutes_total / stats.break_days)
      : 0;

    // Time adherence: actual_hours / scheduled_hours (overtime excluded)
    // Capped at 100% — working more than scheduled without overtime still = 100%
    const adherence = stats.scheduled_hours > 0
      ? Math.min(100, Math.round((stats.actual_hours / stats.scheduled_hours) * 100))
      : 0;

    return {
      profile_id: profileId,
      display_name: stats.display_name,
      initials: stats.initials,
      total_entries: stats.total_entries,
      late_count: stats.late_count,
      late_minutes_total: stats.late_minutes_total,
      avg_late_minutes: stats.late_count > 0 ? Math.round(stats.late_minutes_total / stats.late_count) : 0,
      avg_break_minutes: avgBreakMinutes,
      break_minutes_total: stats.break_minutes_total,
      scheduled_hours: Math.round(stats.scheduled_hours * 100) / 100,
      actual_hours: Math.round(stats.actual_hours * 100) / 100,
      overtime_hours: Math.round(stats.overtime_hours * 100) / 100,
      time_adherence_pct: adherence,
    };
  });

  // Sort by late count descending
  employees.sort((a, b) => b.late_count - a.late_count);

  // Summary stats
  const totalLateInstances = employees.reduce((s, e) => s + e.late_count, 0);
  const avgAdherence = employees.length > 0
    ? Math.round(employees.reduce((s, e) => s + e.time_adherence_pct, 0) / employees.length)
    : 0;
  const avgBreakAll = employees.length > 0
    ? Math.round(employees.reduce((s, e) => s + e.avg_break_minutes, 0) / employees.length)
    : 0;

  return Response.json({
    summary: {
      total_employees: employees.length,
      total_late_instances: totalLateInstances,
      avg_time_adherence: avgAdherence,
      avg_break_minutes: avgBreakAll,
    },
    employees,
  });
}
