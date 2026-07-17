import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/intakes — List intakes (role-filtered via RLS)
 */
export async function GET() {
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

  const { data, error } = await supabase
    .from("customer_intakes")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ intakes: data ?? [] });
}

/**
 * POST /api/intakes — Create a new draft intake
 */
export async function POST(request: Request) {
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  // Ensure the intake is created by the authenticated user
  const row = {
    ...body,
    created_by: userData.user.id,
    status: "draft",
  };

  const { data, error } = await supabase
    .from("customer_intakes")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ id: data.id }, { status: 201 });
}
