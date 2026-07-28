import { canAdministerAttendance } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/payroll
 * Get payroll summaries for the current user or all (super admins).
 * Query: ?period_id=...&profile_id=...
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  const canAdminister = canAdministerAttendance(profile?.role);

  const { searchParams } = new URL(request.url);
  const periodId = searchParams.get("period_id");
  const requestedProfileId = searchParams.get("profile_id");
  const profileId = canAdminister ? requestedProfileId : user.id;

  let query = supabase
    .from("payroll_summaries")
    .select("*, profiles!payroll_summaries_profile_id_fkey(display_name, initials, role), payroll_periods!payroll_summaries_payroll_period_id_fkey(*)")
    .order("created_at", { ascending: false });

  if (periodId) query = query.eq("payroll_period_id", periodId);
  if (profileId) query = query.eq("profile_id", profileId);

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 400 });

  return Response.json({ summaries: data ?? [] });
}

/**
 * GET /api/payroll/periods
 * moved to /api/payroll/periods/route.ts
 */
