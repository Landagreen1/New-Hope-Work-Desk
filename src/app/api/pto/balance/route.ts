import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/pto/balance
 * Get PTO balance for the current user (or specified profile for managers).
 * Query: ?profile_id=...&year=2026
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const profileId = searchParams.get("profile_id") || user.id;
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
