import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/intakes/[id]/assign — Manager assigns intake to an agent via assign_customer_intake RPC
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

  let body: { agentId?: string; reason?: string };
  try {
    body = (await request.json()) as { agentId?: string; reason?: string };
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!body.agentId) {
    return Response.json(
      { error: "agentId is required." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase.rpc("assign_customer_intake", {
    p_intake_id: id,
    p_agent_id: body.agentId,
    p_reason: body.reason ?? null,
  });

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  // data is the resulting quote_id UUID
  return Response.json({ success: true, quote_id: data });
}
