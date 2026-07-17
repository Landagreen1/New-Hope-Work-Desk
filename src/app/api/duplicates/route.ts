import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/duplicates
 * Returns pending duplicate reviews ordered by flagged_at ASC.
 * Accessible by Agents (own reviews) and Managers (all reviews) via RLS.
 */
export async function GET() {
  const supabase = await createClient();
  if (!supabase) {
    return Response.json(
      { error: "Supabase is not configured." },
      { status: 503 },
    );
  }

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const { data, error } = await supabase
    .from("duplicate_reviews")
    .select("*")
    .eq("status", "pending")
    .order("flagged_at", { ascending: true });

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ reviews: data ?? [] });
}
