import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/quotes
 * Lists operational_quotes. RLS handles role filtering:
 * - Agents see only their assigned quotes
 * - Managers see all quotes
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  if (!supabase) {
    return Response.json(
      { error: "Supabase is not configured." },
      { status: 503 },
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  // Parse optional query params for filtering
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const assignedTo = searchParams.get("assigned_to");

  let query = supabase
    .from("operational_quotes")
    .select("*")
    .order("last_progression_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }
  if (assignedTo) {
    query = query.eq("assigned_to", assignedTo);
  }

  const { data, error } = await query;

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ quotes: data ?? [] });
}
