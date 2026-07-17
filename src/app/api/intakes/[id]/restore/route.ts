import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/intakes/[id]/restore — Restore a soft-deleted intake via restore_customer_intake RPC
 */
export async function POST(
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

  const { data, error } = await supabase.rpc("restore_customer_intake", {
    p_intake_id: id,
    p_reason: body.reason.trim(),
  });

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json(data);
}
