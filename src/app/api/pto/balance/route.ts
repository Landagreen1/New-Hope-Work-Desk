import { canAdministerAttendance } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/pto/balance
 * Get PTO balance for the current user (or specified profile for super admins).
 * Query: ?profile_id=...&year=2026
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
  const profileId = canAdminister ? requestedProfileId || user.id : user.id;
  const year = Number(searchParams.get("year") || new Date().getFullYear());

  const { data, error } = await supabase
    .from("pto_balances")
    .select("*")
    .eq("profile_id", profileId)
    .eq("year", year)
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 400 });

  // Return default balance if none exists
  const balance = data ?? {
    profile_id: profileId,
    year,
    vacation_days: 10,
    sick_days: 5,
    personal_days: 3,
    vacation_used: 0,
    sick_used: 0,
    personal_used: 0,
    carryover_days: 0,
  };

  return Response.json({ balance });
}

/**
 * POST /api/pto/balance
 * Create or update PTO balance for an employee (super_admin only).
 * Body: { profile_id, year?, vacation_days, personal_days }
 * personal_days is used for "birthday day" (1 special day).
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!canAdministerAttendance(profile?.role)) {
    return Response.json({ error: "Only super admins can update PTO balances." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const profileId = String(body.profile_id ?? "");
  const year = Number(body.year ?? new Date().getFullYear());
  const vacationDays = Number(body.vacation_days ?? 10);
  const personalDays = Number(body.personal_days ?? 1); // birthday day

  if (!profileId) return Response.json({ error: "profile_id is required." }, { status: 400 });

  // Check if balance row already exists
  const { data: existing } = await supabase
    .from("pto_balances")
    .select("id")
    .eq("profile_id", profileId)
    .eq("year", year)
    .maybeSingle();

  if (existing) {
    // Update only the allocation fields
    const { error } = await supabase
      .from("pto_balances")
      .update({ vacation_days: vacationDays, personal_days: personalDays })
      .eq("id", existing.id);
    if (error) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ success: true, id: existing.id });
  } else {
    // Insert new row with defaults
    const { data, error } = await supabase
      .from("pto_balances")
      .insert({
        profile_id: profileId,
        year,
        vacation_days: vacationDays,
        personal_days: personalDays,
        sick_days: 0,
        carryover_days: 0,
        vacation_used: 0,
        sick_used: 0,
        personal_used: 0,
      })
      .select("id")
      .single();
    if (error) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ success: true, id: data.id });
  }
}
