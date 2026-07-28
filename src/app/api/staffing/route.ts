import { canAdministerAttendance, roleToDepartment } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";
import type { AppRole } from "@/lib/types";

export const runtime = "nodejs";

/**
 * GET /api/staffing
 * Get real-time staffing coverage: who's clocked in per department vs thresholds.
 */
export async function GET() {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!canAdministerAttendance(profile?.role)) {
    return Response.json({ error: "Only super admins can view staffing coverage." }, { status: 403 });
  }

  // Get all currently clocked-in users
  const { data: activeClocks, error: clockError } = await supabase
    .from("time_clock_entries")
    .select("profile_id, clock_status, profiles!time_clock_entries_profile_id_fkey(role, display_name)")
    .is("clock_out", null);

  if (clockError) return Response.json({ error: clockError.message }, { status: 400 });

  // Count by the same canonical department mapping used by navigation and
  // authorization, including scoped supervisors.
  const counts: Record<string, { total: number; available: number; names: string[] }> = {
    sales: { total: 0, available: 0, names: [] },
    customer_service: { total: 0, available: 0, names: [] },
    commercial: { total: 0, available: 0, names: [] },
    management: { total: 0, available: 0, names: [] },
  };

  for (const entry of activeClocks ?? []) {
    const profileData = entry.profiles as unknown as { role: string; display_name: string } | null;
    const role = (profileData?.role ?? "agent") as AppRole;
    const name = profileData?.display_name ?? "Unknown";
    const dept = roleToDepartment(role);
    counts[dept].total++;
    counts[dept].names.push(name);
    if (entry.clock_status === "available") counts[dept].available++;
  }

  // Get thresholds for today
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sunday
  const hour = now.getHours();
  const timeSlot = hour < 12 ? "morning" : "afternoon";

  const { data: thresholds } = await supabase
    .from("staffing_thresholds")
    .select("*")
    .eq("day_of_week", dayOfWeek)
    .in("time_slot", [timeSlot, "full_day"]);

  // Build coverage report
  const departments = ["sales", "customer_service", "commercial", "management"];
  const coverage = departments.map((dept) => {
    const threshold = (thresholds ?? []).find((t) => t.department === dept) ?? {
      minimum_staff: 1,
      warning_threshold: 2,
    };
    const clockedIn = counts[dept].total;
    const minimum = threshold.minimum_staff;
    const warning = threshold.warning_threshold;

    let status: "ok" | "warning" | "critical" = "ok";
    if (clockedIn < minimum) status = "critical";
    else if (clockedIn <= warning) status = "warning";

    return {
      department: dept,
      clocked_in: clockedIn,
      available: counts[dept].available,
      minimum,
      warning,
      status,
      staff_names: counts[dept].names,
    };
  });

  return Response.json({ coverage, timestamp: now.toISOString() });
}
