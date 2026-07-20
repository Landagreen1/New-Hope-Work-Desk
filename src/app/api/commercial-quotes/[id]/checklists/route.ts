import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/commercial-quotes/:id/checklists
 * List all checklists and their items for a commercial quote card.
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
    .from("commercial_quote_checklists")
    .select(
      `id, title, position, created_at,
      commercial_quote_checklist_items(id, label, is_checked, position)`
    )
    .eq("quote_id", id)
    .order("position", { ascending: true });

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ checklists: data ?? [] });
}

/**
 * POST /api/commercial-quotes/:id/checklists
 * Create a new checklist on a commercial quote card.
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

  const title = String(body.title ?? "Checklist").trim();

  // Get next position
  const { data: lastChecklist } = await supabase
    .from("commercial_quote_checklists")
    .select("position")
    .eq("quote_id", id)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextPosition = (lastChecklist?.position ?? 0) + 1;

  const { data, error } = await supabase
    .from("commercial_quote_checklists")
    .insert({
      quote_id: id,
      title,
      position: nextPosition,
    })
    .select("id, title, position")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ checklist: data }, { status: 201 });
}

/**
 * DELETE /api/commercial-quotes/:id/checklists
 * Delete a checklist. Body: { checklist_id: string }
 */
export async function DELETE(request: Request, context: RouteContext) {
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

  const checklistId = String(body.checklist_id ?? "").trim();
  if (!checklistId) {
    return Response.json(
      { error: "checklist_id is required." },
      { status: 400 },
    );
  }

  // Verify the checklist belongs to this quote
  const { error } = await supabase
    .from("commercial_quote_checklists")
    .delete()
    .eq("id", checklistId)
    .eq("quote_id", id);

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ success: true });
}
