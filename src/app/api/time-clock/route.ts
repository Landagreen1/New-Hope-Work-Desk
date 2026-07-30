import { canAdministerAttendance } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Map time-clock status ('available' | 'lunch' | 'unavailable') to the
 * availability_status enum ('available' | 'break' | 'unavailable') used by
 * set_my_availability RPC and the profiles table.
 */
function toAvailabilityEnum(clockStatus: string): string {
  return clockStatus === "lunch" ? "break" : clockStatus;
}

/**
 * Sync profile availability using the set_my_availability RPC when the user is
 * an agent. This ensures rotation queues are properly started/updated.
 * Falls back to a direct profile update for non-agent roles.
 */
async function syncAvailability(
  supabase: Awaited<ReturnType<typeof createClient>> & object,
  userId: string,
  clockStatus: string,
) {
  const availabilityValue = toAvailabilityEnum(clockStatus);

  // Try calling the RPC — it handles rotation queue logic for agents.
  // It will raise 'Agent permission required' for non-agent roles, which is fine.
  const { error } = await supabase.rpc("set_my_availability", { p_status: availabilityValue });

  if (error) {
    // Non-agent roles don't participate in rotation queues —
    // fall back to direct profile update for them.
    await supabase.from("profiles").update({ availability: availabilityValue }).eq("id", userId);
  }
}

/**
 * GET /api/time-clock
 * Get current user's clock entries (or all for managers).
 * Query params: ?profile_id=...&date=YYYY-MM-DD&range=week|month
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  const canAdminister = canAdministerAttendance(profile?.role);

  const { searchParams } = new URL(request.url);
  const requestedProfileId = searchParams.get("profile_id");
  const profileId = canAdminister ? requestedProfileId : user.id;
  const date = searchParams.get("date");
  const range = searchParams.get("range") || "week";

  // Determine date range
  const now = new Date();
  let startDate: string;
  let endDate: string;

  if (date) {
    const d = new Date(date + "T00:00:00");
    if (range === "month") {
      startDate = new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
      endDate = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).toISOString();
    } else {
      // Week: go back to Monday
      const day = d.getDay();
      const diff = day === 0 ? 6 : day - 1;
      const monday = new Date(d);
      monday.setDate(d.getDate() - diff);
      startDate = monday.toISOString();
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      sunday.setHours(23, 59, 59);
      endDate = sunday.toISOString();
    }
  } else {
    // Default: current week
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    const monday = new Date(now);
    monday.setDate(now.getDate() - diff);
    monday.setHours(0, 0, 0, 0);
    startDate = monday.toISOString();
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59);
    endDate = sunday.toISOString();
  }

  let query = supabase
    .from("time_clock_entries")
    .select("*, profiles!time_clock_entries_profile_id_fkey(display_name, initials, role)")
    .gte("clock_in", startDate)
    .lte("clock_in", endDate)
    .order("clock_in", { ascending: false });

  if (profileId) {
    query = query.eq("profile_id", profileId);
  }

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 400 });

  return Response.json({ entries: data ?? [] });
}

/**
 * POST /api/time-clock
 * Clock in. Body: { status?: 'available' | 'lunch' | 'unavailable' }
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  // Check if already clocked in
  const { data: activeEntry } = await supabase
    .from("time_clock_entries")
    .select("id")
    .eq("profile_id", user.id)
    .is("clock_out", null)
    .maybeSingle();

  if (activeEntry) {
    return Response.json({ error: "Already clocked in. Clock out first." }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* empty body ok */ }

  const status = String(body.status ?? "available");
  if (!["available", "lunch", "unavailable"].includes(status)) {
    return Response.json({ error: "Invalid status." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("time_clock_entries")
    .insert({ profile_id: user.id, clock_status: status })
    .select("id, clock_in, clock_status")
    .single();

  if (error) return Response.json({ error: error.message }, { status: 400 });

  // Sync profile availability via set_my_availability RPC (handles rotation queues for agents)
  await syncAvailability(supabase, user.id, status);

  return Response.json({ entry: data }, { status: 201 });
}

/**
 * PATCH /api/time-clock
 * Clock out or update status. Body: { action: 'clock_out' | 'change_status', status?: string }
 */
export async function PATCH(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const action = String(body.action ?? "");

  // Admin edit: adjust any clock entry by ID — handle before active entry check
  if (action === "edit") {
    const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    if (!canAdministerAttendance(profile?.role)) {
      return Response.json({ error: "Only super admins can edit clock entries." }, { status: 403 });
    }

    const entryId = String(body.entry_id ?? "");
    if (!entryId) return Response.json({ error: "entry_id is required." }, { status: 400 });

    const adjustmentReason = String(body.adjustment_reason ?? "").trim();
    if (!adjustmentReason) return Response.json({ error: "adjustment_reason is required." }, { status: 400 });

    const updates: Record<string, unknown> = {
      adjusted_by: user.id,
      adjustment_reason: adjustmentReason,
    };

    if (body.clock_in) updates.clock_in = body.clock_in;
    if (body.clock_out) updates.clock_out = body.clock_out;
    if (body.break_minutes !== undefined) updates.break_minutes = Number(body.break_minutes);

    // Recalculate total_hours if clock_in and clock_out are both known
    const { data: entry } = await supabase
      .from("time_clock_entries")
      .select("clock_in, clock_out, break_minutes")
      .eq("id", entryId)
      .single();

    if (!entry) return Response.json({ error: "Entry not found." }, { status: 404 });

    const finalClockIn = (updates.clock_in ?? entry.clock_in) as string;
    const finalClockOut = (updates.clock_out ?? entry.clock_out) as string | null;
    const finalBreakMin = (updates.break_minutes ?? entry.break_minutes ?? 0) as number;

    if (finalClockIn && finalClockOut) {
      const totalMinutes = (new Date(finalClockOut).getTime() - new Date(finalClockIn).getTime()) / 60000;
      const workMinutes = totalMinutes - finalBreakMin;
      updates.total_hours = Math.round((workMinutes / 60) * 100) / 100;
    }

    const { error } = await supabase
      .from("time_clock_entries")
      .update(updates)
      .eq("id", entryId);

    if (error) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ success: true });
  }

  // Get active clock entry (for clock_out and change_status actions)
  const { data: activeEntry } = await supabase
    .from("time_clock_entries")
    .select("id, clock_in, break_minutes")
    .eq("profile_id", user.id)
    .is("clock_out", null)
    .maybeSingle();

  if (!activeEntry) {
    return Response.json({ error: "Not clocked in." }, { status: 400 });
  }

  if (action === "clock_out") {
    const now = new Date();
    const clockIn = new Date(activeEntry.clock_in);
    const totalMinutes = (now.getTime() - clockIn.getTime()) / 60000;
    const workMinutes = totalMinutes - (activeEntry.break_minutes || 0);
    const totalHours = Math.round((workMinutes / 60) * 100) / 100;

    // End any active breaks
    await supabase
      .from("time_clock_breaks")
      .update({ break_end: now.toISOString(), duration_minutes: 0 })
      .eq("clock_entry_id", activeEntry.id)
      .is("break_end", null);

    const { error } = await supabase
      .from("time_clock_entries")
      .update({ clock_out: now.toISOString(), total_hours: totalHours })
      .eq("id", activeEntry.id);

    if (error) return Response.json({ error: error.message }, { status: 400 });

    // Sync profile availability via set_my_availability RPC (handles rotation queues for agents)
    await syncAvailability(supabase, user.id, "unavailable");

    return Response.json({ success: true, total_hours: totalHours });
  }

  return Response.json({ error: "Invalid action. Use 'clock_out' or 'edit'." }, { status: 400 });
}