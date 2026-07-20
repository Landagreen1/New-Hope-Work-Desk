import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/schedules
 * Get schedules. Query params: ?profile_id=...&week=YYYY-MM-DD
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const profileId = searchParams.get("profile_id");
  const week = searchParams.get("week"); // Monday of the week

  let query = supabase
    .from("employee_schedules")
    .select("*, profiles!employee_schedules_profile_id_fkey(display_name, initials, role)")
    .order("schedule_date", { ascending: true })
    .order("shift_start", { ascending: true });

  if (profileId) {
    query = query.eq("profile_id", profileId);
  }

  if (week) {
    const start = new Date(week + "T00:00:00");
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    query = query.gte("schedule_date", start.toISOString().split("T")[0]);
    query = query.lte("schedule_date", end.toISOString().split("T")[0]);
  }

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 400 });

  return Response.json({ schedules: data ?? [] });
}

/**
 * POST /api/schedules
 * Create a schedule entry (manager only).
 * Body: { profile_id, schedule_date, shift_start, shift_end, shift_type?, notes? }
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "manager") {
    return Response.json({ error: "Only managers can create schedules." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const profileId = String(body.profile_id ?? "");
  const scheduleDate = String(body.schedule_date ?? "");
  const shiftStart = String(body.shift_start ?? "");
  const shiftEnd = String(body.shift_end ?? "");

  if (!profileId || !scheduleDate || !shiftStart || !shiftEnd) {
    return Response.json({ error: "profile_id, schedule_date, shift_start, and shift_end are required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("employee_schedules")
    .upsert({
      profile_id: profileId,
      schedule_date: scheduleDate,
      shift_start: shiftStart,
      shift_end: shiftEnd,
      shift_type: body.shift_type ?? "regular",
      status: "published",
      notes: body.notes ?? null,
      created_by: user.id,
    }, { onConflict: "profile_id,schedule_date" })
    .select("id")
    .single();

  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ id: data.id }, { status: 201 });
}
