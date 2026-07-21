import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/commercial-quotes/:id
 * Get a single commercial quote with all related data.
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
    .from("commercial_quotes")
    .select(
      `*,
      commercial_quote_comments(
        id, content, created_at, updated_at,
        profiles!commercial_quote_comments_author_id_fkey(display_name, initials)
      ),
      commercial_quote_attachments(
        id, file_name, file_size, mime_type, storage_path, created_at,
        profiles!commercial_quote_attachments_uploaded_by_fkey(display_name)
      ),
      commercial_quote_checklists(
        id, title, position,
        commercial_quote_checklist_items(id, label, is_checked, position)
      ),
      commercial_quote_column_history(
        id, from_column, to_column, moved_at,
        profiles!commercial_quote_column_history_moved_by_fkey(display_name)
      ),
      profiles!commercial_quotes_assigned_to_fkey(display_name, initials, role)`
    )
    .eq("id", id)
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 404 });
  }

  return Response.json({ quote: data });
}

/**
 * PATCH /api/commercial-quotes/:id
 * Update a commercial quote (fields, status, risk level, etc.)
 */
export async function PATCH(request: Request, context: RouteContext) {
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

  // Only allow safe fields to be updated
  const allowedFields = [
    "business_name",
    "description",
    "risk_level",
    "card_status",
    "policy_number",
    "coverage_type",
    "coverage_type_other",
    "is_mirrored",
    "assigned_to",
    "sold_premium",
    "commission_notes",
  ];

  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (field in body) {
      updates[field] = body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    return Response.json(
      { error: "No valid fields to update." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from("commercial_quotes")
    .update(updates)
    .eq("id", id)
    .select("id")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ id: data.id });
}

/**
 * DELETE /api/commercial-quotes/:id
 * Soft-delete a commercial quote card (both agents and managers).
 * Managers can also hard-delete by passing ?hard=true.
 * Body (optional): { reason?: string }
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

  const { searchParams } = new URL(request.url);
  const hardDelete = searchParams.get("hard") === "true";

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // Body is optional for delete
  }

  const reason = String(body.reason ?? "").trim();

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  // Hard delete: managers only
  if (hardDelete) {
    if (profile?.role !== "manager" && profile?.role !== "super_admin") {
      return Response.json(
        { error: "Only managers can permanently delete cards." },
        { status: 403 },
      );
    }

    const { error } = await supabase
      .from("commercial_quotes")
      .delete()
      .eq("id", id);

    if (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }

    return Response.json({ success: true, type: "hard_delete" });
  }

  // Soft delete: available to both commercial agents (own cards) and managers
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("commercial_quotes")
    .update({
      is_deleted: true,
      deleted_at: now,
      deleted_by: user.id,
      deleted_reason: reason || null,
    })
    .eq("id", id);

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  // Log the deletion
  await supabase.from("commercial_quote_activity_log").insert({
    quote_id: id,
    actor_id: user.id,
    event_type: "card_deleted",
    details: { reason: reason || null },
  });

  return Response.json({ success: true, type: "soft_delete" });
}
