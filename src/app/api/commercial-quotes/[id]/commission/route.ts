import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * PATCH /api/commercial-quotes/:id/commission
 * Manager action: approve or deny commission on a sold quote.
 * Body: { decision: 'approved' | 'denied', reason?: string, notes?: string }
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

  // Only managers can approve/deny commissions
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, display_name")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "manager") {
    return Response.json(
      { error: "Only managers can approve or deny commissions." },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const decision = String(body.decision ?? "");
  if (!["approved", "denied"].includes(decision)) {
    return Response.json(
      { error: "Decision must be 'approved' or 'denied'." },
      { status: 400 },
    );
  }

  // Denial requires a reason
  const reason = String(body.reason ?? "").trim();
  if (decision === "denied" && !reason) {
    return Response.json(
      { error: "A denial reason is required." },
      { status: 400 },
    );
  }

  const notes = String(body.notes ?? "").trim();

  // Verify the card is in 'sold' column (eligible for commission review)
  const { data: quote, error: fetchError } = await supabase
    .from("commercial_quotes")
    .select("id, board_column, commission_status")
    .eq("id", id)
    .single();

  if (fetchError || !quote) {
    return Response.json({ error: "Card not found." }, { status: 404 });
  }

  if (quote.board_column !== "sold" && quote.board_column !== "commission_approved" && quote.board_column !== "commission_not_approved") {
    return Response.json(
      { error: "Commission decision can only be made on sold cards." },
      { status: 400 },
    );
  }

  // Update commission fields and move to appropriate column
  const targetColumn = decision === "approved" ? "commission_approved" : "commission_not_approved";
  const now = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("commercial_quotes")
    .update({
      commission_status: decision,
      commission_decision_by: user.id,
      commission_decision_at: now,
      commission_denial_reason: decision === "denied" ? reason : null,
      commission_notes: notes || null,
      board_column: targetColumn,
      column_entered_at: now,
    })
    .eq("id", id);

  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 400 });
  }

  // Record column history
  await supabase.from("commercial_quote_column_history").insert({
    quote_id: id,
    from_column: quote.board_column,
    to_column: targetColumn,
    moved_by: user.id,
  });

  // Record activity log
  await supabase.from("commercial_quote_activity_log").insert({
    quote_id: id,
    actor_id: user.id,
    event_type: decision === "approved" ? "commission_approved" : "commission_denied",
    details: {
      reason: reason || null,
      notes: notes || null,
      from_column: quote.board_column,
      to_column: targetColumn,
    },
  });

  return Response.json({
    success: true,
    decision,
    target_column: targetColumn,
  });
}
