import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/time-clock/active
 * Get the current user's active clock entry (if clocked in) + active break.
 */
export async function GET() {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: activeEntry } = await supabase
    .from("time_clock_entries")
    .select("id, clock_in, clock_status, break_minutes")
    .eq("profile_id", user.id)
    .is("clock_out", null)
    .maybeSingle();

  if (!activeEntry) {
    return Response.json({ clocked_in: false, entry: null, active_break: null });
  }

  // Check for active break
  const { data: activeBreak } = await supabase
    .from("time_clock_breaks")
    .select("id, break_start, break_type")
    .eq("clock_entry_id", activeEntry.id)
    .is("break_end", null)
    .maybeSingle();

  return Response.json({
    clocked_in: true,
    entry: activeEntry,
    active_break: activeBreak,
  });
}
