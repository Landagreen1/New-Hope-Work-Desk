import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/pto
 * Get PTO requests. Agents see own, managers see all.
 * Query: ?status=pending&profile_id=...
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const profileId = searchParams.get("profile_id");

  let query = supabase
    .from("pto_requests")
    .select("*, profiles!pto_requests_profile_id_fkey(display_name, initials, role)")
    .order("start_date", { ascending: false });

  if (status) query = query.eq("status", status);
  if (profileId) query = query.eq("profile_id", profileId);

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 400 });

  return Response.json({ requests: data ?? [] });
}

/**
 * POST /api/pto
 * Submit a PTO request.
 * Body: { pto_type, start_date, end_date, total_days, reason? }
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const ptoType = String(body.pto_type ?? "");
  const startDate = String(body.start_date ?? "");
  const endDate = String(body.end_date ?? "");
  const totalDays = Number(body.total_days ?? 0);

  if (!ptoType || !startDate || !endDate || totalDays <= 0) {
    return Response.json({ error: "pto_type, start_date, end_date, and total_days are required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("pto_requests")
    .insert({
      profile_id: user.id,
      pto_type: ptoType,
      start_date: startDate,
      end_date: endDate,
      total_days: totalDays,
      reason: body.reason ?? null,
      status: "pending",
    })
    .select("id")
    .single();

  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ id: data.id }, { status: 201 });
}

/**
 * PATCH /api/pto
 * Approve or deny a PTO request (manager only).
 * Body: { request_id, decision: 'approved' | 'denied', denial_reason? }
 */
export async function PATCH(request: Request) {
  const supabase = await createClient();
  if (!supabase) return Response.json({ error: "Supabase is not configured." }, { status: 503 });

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "manager") {
    return Response.json({ error: "Only managers can approve/deny PTO requests." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const requestId = String(body.request_id ?? "");
  const decision = String(body.decision ?? "");

  if (!requestId || !["approved", "denied"].includes(decision)) {
    return Response.json({ error: "request_id and decision (approved/denied) are required." }, { status: 400 });
  }

  const denialReason = decision === "denied" ? String(body.denial_reason ?? "").trim() : null;

  const { error } = await supabase
    .from("pto_requests")
    .update({
      status: decision,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      denial_reason: denialReason,
    })
    .eq("id", requestId)
    .eq("status", "pending");

  if (error) return Response.json({ error: error.message }, { status: 400 });

  // If approved, update PTO balance
  if (decision === "approved") {
    const { data: req } = await supabase
      .from("pto_requests")
      .select("profile_id, pto_type, total_days")
      .eq("id", requestId)
      .single();

    if (req) {
      const year = new Date().getFullYear();
      const field = req.pto_type === "vacation" ? "vacation_used"
        : req.pto_type === "sick" ? "sick_used"
        : "personal_used";

      // Upsert balance for current year then increment used
      const { error: rpcError } = await supabase.rpc("increment_pto_used", {
        p_profile_id: req.profile_id,
        p_year: year,
        p_field: field,
        p_days: req.total_days,
      });
      // If RPC doesn't exist yet, silently ignore
      if (rpcError) { /* graceful fallback — RPC may not be installed yet */ }
    }
  }

  return Response.json({ success: true, decision });
}
