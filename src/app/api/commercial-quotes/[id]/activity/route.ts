import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/commercial-quotes/:id/activity
 * Get the full activity log for a commercial quote card.
 */
export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;

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
    .from("commercial_quote_activity_log")
    .select(
      `id, quote_id, actor_id, event_type, details, created_at,
      profiles!commercial_quote_activity_log_actor_id_fkey(display_name, initials)`
    )
    .eq("quote_id", id)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ activity: data ?? [] });
}

/**
 * POST /api/commercial-quotes/:id/activity
 * Log an activity event (used internally by other endpoints or for manual logging).
 */
export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;

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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const eventType = String(body.event_type ?? "");
  if (!eventType) {
    return Response.json(
      { error: "event_type is required." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from("commercial_quote_activity_log")
    .insert({
      quote_id: id,
      actor_id: user.id,
      event_type: eventType,
      details: (body.details as Record<string, unknown>) ?? null,
    })
    .select("id")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ id: data.id }, { status: 201 });
}
