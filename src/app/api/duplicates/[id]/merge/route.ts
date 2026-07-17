import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/duplicates/[id]/merge
 * Merges two quote records via the merge_quote_records RPC.
 * Body: { survivingId: string, mergedId: string, fieldSelections: object, reason: string }
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

  // The [id] param is the review ID for context, but merge uses explicit quote IDs
  await params;

  let body: {
    survivingId?: string;
    mergedId?: string;
    fieldSelections?: Record<string, string>;
    reason?: string;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.survivingId || !body.mergedId) {
    return Response.json(
      { error: "Both survivingId and mergedId are required." },
      { status: 400 },
    );
  }

  if (!body.fieldSelections || Object.keys(body.fieldSelections).length === 0) {
    return Response.json(
      { error: "Field selections are required for merge." },
      { status: 400 },
    );
  }

  if (!body.reason || body.reason.trim().length === 0) {
    return Response.json(
      { error: "A reason is required for merge." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc("merge_quote_records", {
    p_surviving_id: body.survivingId,
    p_merged_id: body.mergedId,
    p_field_selections: body.fieldSelections,
    p_reason: body.reason.trim(),
  });

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  const result = data as {
    success: boolean;
    surviving_id?: string;
    merged_id?: string;
    error?: string;
  };
  if (!result.success) {
    return Response.json({ error: result.error }, { status: 422 });
  }

  return Response.json(result);
}
