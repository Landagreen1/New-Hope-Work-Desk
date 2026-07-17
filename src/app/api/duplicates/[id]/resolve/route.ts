import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/duplicates/[id]/resolve
 * Resolves a duplicate review via the resolve_quote_duplicate RPC.
 * Body: { decision: string, fieldSelections?: object, reason?: string }
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  if (!supabase) {
    return Response.json(
      { error: "Supabase is not configured." },
      { status: 503 },
    );
  }

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const { id } = await params;

  let body: { decision?: string; fieldSelections?: Record<string, string>; reason?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.decision) {
    return Response.json(
      { error: "Decision is required (not_duplicate, merge, or keep_both_link)." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc("resolve_quote_duplicate", {
    p_review_id: id,
    p_decision: body.decision,
    p_field_selections: body.fieldSelections ?? null,
    p_reason: body.reason ?? null,
  });

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  const result = data as { success: boolean; error?: string; decision?: string };
  if (!result.success) {
    return Response.json({ error: result.error }, { status: 422 });
  }

  return Response.json(result);
}
