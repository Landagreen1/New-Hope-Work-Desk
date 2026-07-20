import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/commercial-quotes/:id/comments
 * List all comments on a commercial quote card.
 */
export async function GET(request: Request, context: RouteContext) {
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

  const { data, error } = await supabase
    .from("commercial_quote_comments")
    .select(
      `id, content, created_at, updated_at, author_id,
      profiles!commercial_quote_comments_author_id_fkey(display_name, initials)`
    )
    .eq("quote_id", id)
    .order("created_at", { ascending: false });

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ comments: data ?? [] });
}

/**
 * POST /api/commercial-quotes/:id/comments
 * Add a comment to a commercial quote card.
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

  const content = String(body.content ?? "").trim();
  if (!content) {
    return Response.json(
      { error: "Comment content is required." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from("commercial_quote_comments")
    .insert({
      quote_id: id,
      author_id: user.id,
      content,
    })
    .select("id, content, created_at")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ comment: data }, { status: 201 });
}
