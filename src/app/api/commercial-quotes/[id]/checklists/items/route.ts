import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/commercial-quotes/:id/checklists/items
 * Add an item to a checklist. Body: { checklist_id, label }
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

  const checklistId = String(body.checklist_id ?? "").trim();
  const label = String(body.label ?? "").trim();

  if (!checklistId) {
    return Response.json(
      { error: "checklist_id is required." },
      { status: 400 },
    );
  }
  if (!label) {
    return Response.json(
      { error: "Item label is required." },
      { status: 400 },
    );
  }

  // Verify checklist belongs to this quote
  const { data: checklist } = await supabase
    .from("commercial_quote_checklists")
    .select("id")
    .eq("id", checklistId)
    .eq("quote_id", id)
    .maybeSingle();

  if (!checklist) {
    return Response.json(
      { error: "Checklist not found for this card." },
      { status: 404 },
    );
  }

  // Get next position
  const { data: lastItem } = await supabase
    .from("commercial_quote_checklist_items")
    .select("position")
    .eq("checklist_id", checklistId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextPosition = (lastItem?.position ?? 0) + 1;

  const { data, error } = await supabase
    .from("commercial_quote_checklist_items")
    .insert({
      checklist_id: checklistId,
      label,
      is_checked: false,
      position: nextPosition,
    })
    .select("id, label, is_checked, position")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ item: data }, { status: 201 });
}

/**
 * PATCH /api/commercial-quotes/:id/checklists/items
 * Toggle or update a checklist item. Body: { item_id, is_checked?, label? }
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

  const itemId = String(body.item_id ?? "").trim();
  if (!itemId) {
    return Response.json(
      { error: "item_id is required." },
      { status: 400 },
    );
  }

  // Verify this item belongs to a checklist on this quote
  const { data: item } = await supabase
    .from("commercial_quote_checklist_items")
    .select(
      `id,
      commercial_quote_checklists!inner(quote_id)`
    )
    .eq("id", itemId)
    .eq("commercial_quote_checklists.quote_id", id)
    .maybeSingle();

  if (!item) {
    return Response.json(
      { error: "Checklist item not found for this card." },
      { status: 404 },
    );
  }

  const updates: Record<string, unknown> = {};
  if (typeof body.is_checked === "boolean") {
    updates.is_checked = body.is_checked;
  }
  if (typeof body.label === "string" && body.label.trim()) {
    updates.label = body.label.trim();
  }

  if (Object.keys(updates).length === 0) {
    return Response.json(
      { error: "Provide is_checked or label to update." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from("commercial_quote_checklist_items")
    .update(updates)
    .eq("id", itemId)
    .select("id, label, is_checked, position")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ item: data });
}

/**
 * DELETE /api/commercial-quotes/:id/checklists/items
 * Delete a checklist item. Body: { item_id }
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

  const itemId = String(body.item_id ?? "").trim();
  if (!itemId) {
    return Response.json(
      { error: "item_id is required." },
      { status: 400 },
    );
  }

  // Verify item belongs to a checklist on this quote, then delete
  const { data: item } = await supabase
    .from("commercial_quote_checklist_items")
    .select(
      `id,
      commercial_quote_checklists!inner(quote_id)`
    )
    .eq("id", itemId)
    .eq("commercial_quote_checklists.quote_id", id)
    .maybeSingle();

  if (!item) {
    return Response.json(
      { error: "Checklist item not found for this card." },
      { status: 404 },
    );
  }

  const { error } = await supabase
    .from("commercial_quote_checklist_items")
    .delete()
    .eq("id", itemId);

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ success: true });
}
