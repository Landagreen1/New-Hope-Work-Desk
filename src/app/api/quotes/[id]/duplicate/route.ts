import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/quotes/[id]/duplicate
 * Flags a quote as a possible duplicate by calling the flag_quote_duplicate RPC.
 * Body: { original_quote_id: string, reason: string }
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

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

  let body: { original_quote_id?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.original_quote_id) {
    return Response.json(
      { error: "Original quote ID is required." },
      { status: 400 },
    );
  }

  if (!body.reason || body.reason.length < 10 || body.reason.length > 500) {
    return Response.json(
      { error: "Reason must be between 10 and 500 characters." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc("flag_quote_duplicate", {
    p_quote_id: id,
    p_original_quote_id: body.original_quote_id,
    p_reason: body.reason,
  });

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ success: true, review_id: data?.review_id ?? data });
}

/**
 * GET /api/quotes/[id]/duplicate
 * Gets the duplicate review data for this quote (if any).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

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

  const { data, error } = await supabase
    .from("duplicate_reviews")
    .select("*")
    .or(`flagged_quote_id.eq.${id},original_quote_id.eq.${id}`)
    .order("flagged_at", { ascending: false });

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ reviews: data ?? [] });
}
