import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const VALID_COLUMNS = [
  "quote_intake",
  "quoting",
  "price_sent",
  "sold",
  "not_sold",
  "commission_approved",
  "commission_not_approved",
  "archive",
];

// Columns agents are allowed to move cards TO
const AGENT_ALLOWED_TARGETS = [
  "quote_intake",
  "quoting",
  "price_sent",
  "sold",
  "not_sold",
];

// Columns that are locked (agents cannot move cards FROM these)
const LOCKED_COLUMNS = [
  "commission_approved",
  "commission_not_approved",
  "archive",
];

/**
 * PATCH /api/commercial-quotes/:id/move
 * Move a card to a different column (drag-and-drop) and/or reorder within column.
 * Enforces flow rules:
 *   - Agents: can move between quote_intake, quoting, price_sent, sold, not_sold
 *   - Managers: can move anywhere (including commission_approved/denied, archive)
 *   - Cards in locked columns cannot be moved by agents
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

  // Get user role
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  const isManager = profile?.role === "manager";

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const toColumn = String(body.board_column ?? "");
  const newPosition = typeof body.column_position === "number" ? body.column_position : null;

  if (!toColumn || !VALID_COLUMNS.includes(toColumn)) {
    return Response.json(
      { error: `Invalid column. Must be one of: ${VALID_COLUMNS.join(", ")}` },
      { status: 400 },
    );
  }

  // Get current card state
  const { data: currentCard, error: fetchError } = await supabase
    .from("commercial_quotes")
    .select("id, board_column, column_position")
    .eq("id", id)
    .single();

  if (fetchError || !currentCard) {
    return Response.json({ error: "Card not found." }, { status: 404 });
  }

  const fromColumn = currentCard.board_column;
  const isColumnChange = fromColumn !== toColumn;

  // ─── Flow rule enforcement ────────────────────────────────────────────────
  if (!isManager) {
    // Agents cannot move cards FROM locked columns
    if (LOCKED_COLUMNS.includes(fromColumn)) {
      return Response.json(
        { error: "This card is locked and cannot be moved." },
        { status: 403 },
      );
    }

    // Agents cannot move cards TO manager-only columns
    if (!AGENT_ALLOWED_TARGETS.includes(toColumn)) {
      return Response.json(
        { error: "You don't have permission to move cards to this column." },
        { status: 403 },
      );
    }
  }

  // Build update payload
  const updates: Record<string, unknown> = {
    board_column: toColumn,
  };

  if (newPosition !== null) {
    updates.column_position = newPosition;
  } else if (isColumnChange) {
    // If moving to a new column without specifying position, put at end
    const { data: lastInColumn } = await supabase
      .from("commercial_quotes")
      .select("column_position")
      .eq("board_column", toColumn)
      .order("column_position", { ascending: false })
      .limit(1)
      .maybeSingle();

    updates.column_position = (lastInColumn?.column_position ?? 0) + 1;
  }

  // If changing columns, update column_entered_at for time-in-list tracking
  if (isColumnChange) {
    updates.column_entered_at = new Date().toISOString();

    // When moved to sold, record sold_at and set commission_status to pending
    if (toColumn === "sold") {
      updates.sold_at = new Date().toISOString();
      updates.commission_status = "pending";
    }

    // Archive tracking
    if (toColumn === "archive") {
      updates.archived_at = new Date().toISOString();
    } else if (fromColumn === "archive") {
      updates.archived_at = null;
    }
  }

  const { error: updateError } = await supabase
    .from("commercial_quotes")
    .update(updates)
    .eq("id", id);

  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 400 });
  }

  // Record column history if column changed
  if (isColumnChange) {
    await supabase.from("commercial_quote_column_history").insert({
      quote_id: id,
      from_column: fromColumn,
      to_column: toColumn,
      moved_by: user.id,
    });

    // Record activity log
    await supabase.from("commercial_quote_activity_log").insert({
      quote_id: id,
      actor_id: user.id,
      event_type: "column_moved",
      details: { from_column: fromColumn, to_column: toColumn },
    });
  }

  return Response.json({ success: true, from: fromColumn, to: toColumn });
}
