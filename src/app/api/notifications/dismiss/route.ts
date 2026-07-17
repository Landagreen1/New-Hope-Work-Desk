import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/notifications/dismiss
 * Dismisses a notification (hides it from the list).
 * Body: { notificationId: string }
 * Sets is_dismissed=true and dismissed_at to current timestamp.
 * Requirements: 19.5
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
    .update({
      is_dismissed: true,
      dismissed_at: new Date().toISOString(),
    })
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
