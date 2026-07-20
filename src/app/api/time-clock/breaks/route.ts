import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/time-clock/breaks
 * Start a break. Body: { break_type?: 'lunch' | 'short' | 'personal' }
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  // Get active clock entry
  const { data: activeEntry } = await supabase
    .from("time_clock_entries")
    .select("id")
    .eq("profile_id", user.id)
    .is("clock_out", null)
    .maybeSingle();

  if (!activeEntry) return Response.json({ error: "Not clocked in." }, { status: 400 });

  // Check for active break
  const { data: activeBreak } = await supabase
    .from("time_clock_breaks")
    .select("id")
    .eq("clock_entry_id", activeEntry.id)
    .is("break_end", null)
    .maybeSingle();

  if (activeBreak) return Response.json({ error: "Already on break. End current break first." }, { status: 400 });

  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* ok */ }

  const breakType = String(body.break_type ?? "lunch");
  if (!["lunch", "short", "personal"].includes(breakType)) {
    return Response.json({ error: "Invalid break type." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("time_clock_breaks")
    .insert({ clock_entry_id: activeEntry.id, break_type: breakType })
    .select("id, break_start, break_type")
    .single();

  if (error) return Response.json({ error: error.message }, { status: 400 });

  // Update status to lunch/unavailable
  const newStatus = breakType === "lunch" ? "lunch" : "unavailable";
  await supabase.from("time_clock_entries").update({ clock_status: newStatus }).eq("id", activeEntry.id);
  await supabase.from("profiles").update({ availability: newStatus === "lunch" ? "break" : "unavailable" }).eq("id", user.id);

  return Response.json({ break: data }, { status: 201 });
}

/**
 * PATCH /api/time-clock/breaks
 * End the current break.
 */
export async function PATCH(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  // Get active clock entry
  const { data: activeEntry } = await supabase
    .from("time_clock_entries")
    .select("id, break_minutes")
    .eq("profile_id", user.id)
    .is("clock_out", null)
    .maybeSingle();

  if (!activeEntry) return Response.json({ error: "Not clocked in." }, { status: 400 });

  // Get active break
  const { data: activeBreak } = await supabase
    .from("time_clock_breaks")
    .select("id, break_start")
    .eq("clock_entry_id", activeEntry.id)
    .is("break_end", null)
    .maybeSingle();

  if (!activeBreak) return Response.json({ error: "No active break to end." }, { status: 400 });

  const now = new Date();
  const breakStart = new Date(activeBreak.break_start);
  const durationMinutes = Math.round((now.getTime() - breakStart.getTime()) / 60000);

  // End the break
  const { error } = await supabase
    .from("time_clock_breaks")
    .update({ break_end: now.toISOString(), duration_minutes: durationMinutes })
    .eq("id", activeBreak.id);

  if (error) return Response.json({ error: error.message }, { status: 400 });

  // Update total break minutes on the clock entry
  const newBreakMinutes = (activeEntry.break_minutes || 0) + durationMinutes;
  await supabase
    .from("time_clock_entries")
    .update({ break_minutes: newBreakMinutes, clock_status: "available" })
    .eq("id", activeEntry.id);

  // Set back to available
  await supabase.from("profiles").update({ availability: "available" }).eq("id", user.id);

  return Response.json({ success: true, duration_minutes: durationMinutes });
}
