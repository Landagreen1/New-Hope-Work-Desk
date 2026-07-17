import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/quotes/[id]
 * Returns a single operational quote by ID.
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
    .from("operational_quotes")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (!data) {
    return Response.json({ error: "Quote not found." }, { status: 404 });
  }

  return Response.json({ quote: data });
}

/**
 * PATCH /api/quotes/[id]
 * Updates the status of a quote (status change via RPC for transition enforcement).
 * Body: { status: string, reason?: string }
 */
export async function PATCH(
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

  let body: { status?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.status) {
    return Response.json(
      { error: "Status is required." },
      { status: 400 },
    );
  }

  // Use the change_quote_status RPC to enforce state machine transitions
  const { data, error } = await supabase.rpc("change_quote_status", {
    p_quote_id: id,
    p_new_status: body.status,
    p_reason: body.reason ?? null,
  });

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ success: true, data });
}
