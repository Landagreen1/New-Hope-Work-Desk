import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/intakes/[id] — Get intake detail
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

  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const { data, error } = await supabase
    .from("customer_intakes")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    return Response.json(
      { error: error?.message || "Intake not found." },
      { status: 404 },
    );
  }

  return Response.json({ intake: data });
}

/**
 * PATCH /api/intakes/[id] — Update intake via update_customer_intake RPC
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

  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  let body: { changes?: Record<string, unknown>; reason?: string };
  try {
    body = (await request.json()) as {
      changes?: Record<string, unknown>;
      reason?: string;
    };
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.changes || typeof body.changes !== "object") {
    return Response.json(
      { error: "Request body must include a 'changes' object." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc("update_customer_intake", {
    p_intake_id: id,
    p_changes: body.changes,
    p_reason: body.reason ?? null,
  });

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json(data);
}

/**
 * DELETE /api/intakes/[id] — Soft-delete intake via delete_customer_intake RPC
 */
export async function DELETE(
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

  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  let body: { reason?: string };
  try {
    body = (await request.json()) as { reason?: string };
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.reason || body.reason.trim().length < 5) {
    return Response.json(
      { error: "A reason of at least 5 characters is required." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc("delete_customer_intake", {
    p_intake_id: id,
    p_reason: body.reason.trim(),
  });

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json(data);
}
