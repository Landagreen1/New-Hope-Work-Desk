import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/intakes/[id]/claim — Claim a RingCentral intake via claim_ringcentral_intake RPC
 */
export async function POST(
  _request: Request,
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

  const { data, error } = await supabase.rpc("claim_ringcentral_intake", {
    p_intake_id: id,
  });

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  // data is the resulting quote_id UUID
  return Response.json({ success: true, quote_id: data });
}
