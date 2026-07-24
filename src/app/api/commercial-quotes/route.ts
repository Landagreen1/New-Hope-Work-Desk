import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/commercial-quotes
 * Lists commercial quotes on the Kanban board.
 * RLS handles visibility: commercial agents see own cards, managers see all.
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

  const { searchParams } = new URL(request.url);
  const boardColumn = searchParams.get("board_column");
  const assignedTo = searchParams.get("assigned_to");
  const includeDeleted = searchParams.get("include_deleted") === "true";

  let query = supabase
    .from("commercial_quotes")
    .select(
      `*,
      commercial_quote_comments(count),
      commercial_quote_attachments(count),
      commercial_quote_checklists(
        id,
        commercial_quote_checklist_items(id, is_checked)
      ),
      profiles!commercial_quotes_assigned_to_fkey(display_name, initials, role)`
    )
    .order("column_position", { ascending: true });

  // Exclude deleted cards unless explicitly requested (for database view)
  if (!includeDeleted) {
    query = query.eq("is_deleted", false);
  }

  if (boardColumn) {
    query = query.eq("board_column", boardColumn);
  }
  if (assignedTo) {
    query = query.eq("assigned_to", assignedTo);
  }

  // Exclude archived by default unless explicitly requested
  if (!boardColumn || boardColumn !== "archive") {
    query = query.neq("board_column", "archive");
  }

  const { data, error } = await query;

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ quotes: data ?? [] });
}

/**
 * POST /api/commercial-quotes
 * Create a new commercial quote card on the board.
 */
export async function POST(request: Request) {
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

  const businessName = String(body.business_name ?? "").trim();
  if (!businessName) {
    return Response.json(
      { error: "Business name is required." },
      { status: 400 },
    );
  }

  // Get next position in the target column
  const targetColumn = String(body.board_column ?? "quote_intake");
  const { data: lastCard } = await supabase
    .from("commercial_quotes")
    .select("column_position")
    .eq("board_column", targetColumn)
    .order("column_position", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextPosition = (lastCard?.column_position ?? 0) + 1;

  const row = {
    business_name: businessName,
    description: body.description ?? null,
    board_column: targetColumn,
    column_position: nextPosition,
    risk_level: body.risk_level ?? "medium",
    card_status: body.card_status ?? "in_progress",
    policy_number: body.policy_number ?? null,
    coverage_type: body.coverage_type ?? null,
    coverage_type_other: body.coverage_type_other ?? null,
    assigned_to: body.assigned_to ?? user.id,
    is_mirrored: body.is_mirrored ?? true,
  };

  const { data, error } = await supabase
    .from("commercial_quotes")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  // Record column history
  await supabase.from("commercial_quote_column_history").insert({
    quote_id: data.id,
    from_column: null,
    to_column: targetColumn,
    moved_by: user.id,
  });

  // Create default checklist: Email / Recording / Form
  const { data: checklist } = await supabase
    .from("commercial_quote_checklists")
    .insert({ quote_id: data.id, title: "Required Documents" })
    .select("id")
    .single();

  if (checklist) {
    await supabase.from("commercial_quote_checklist_items").insert([
      { checklist_id: checklist.id, label: "Email", position: 1 },
      { checklist_id: checklist.id, label: "Recording", position: 2 },
      { checklist_id: checklist.id, label: "Form", position: 3 },
    ]);
  }

  return Response.json({ id: data.id }, { status: 201 });
}
