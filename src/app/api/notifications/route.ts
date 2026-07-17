import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/notifications
 * Returns unread/undismissed notifications for the current user.
 * Ordered by created_at DESC, limited to 50.
 * Requirements: 19.3
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
  const userId = userData?.user?.id;
  if (!userId) {
    return Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    .eq("recipient_id", userId)
    .eq("is_dismissed", false)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ notifications: data ?? [] });
}

/**
 * PATCH /api/notifications
 * Marks a notification as read.
 * Body: { notificationId: string }
 * Requirements: 19.5
 */
export async function PATCH(request: Request) {
  const supabase = await createClient();
  if (!supabase) {
    return Response.json(
      { error: "Supabase is not configured." },
      { status: 503 },
    );
  }

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) {
    return Response.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: "Invalid request body." },
      { status: 400 },
    );
  }

  const notificationId = String(body.notificationId ?? "").trim();
  if (!notificationId) {
    return Response.json(
      { error: "notificationId is required." },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from("notifications")
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("recipient_id", userId)
    .select("id")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return Response.json(
      { error: "Notification not found or access denied." },
      { status: 404 },
    );
  }

  return Response.json({ success: true });
}
