import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/commercial-quotes/:id/attachments/download?path=...
 * Generate a signed download URL for a commercial quote attachment.
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

  const { searchParams } = new URL(request.url);
  const storagePath = searchParams.get("path");

  if (!storagePath) {
    return Response.json(
      { error: "Storage path is required." },
      { status: 400 },
    );
  }

  // Verify the attachment belongs to this quote (security check)
  const { data: attachment, error: fetchError } = await supabase
    .from("commercial_quote_attachments")
    .select("id")
    .eq("quote_id", id)
    .eq("storage_path", storagePath)
    .maybeSingle();

  if (fetchError || !attachment) {
    return Response.json(
      { error: "Attachment not found for this card." },
      { status: 404 },
    );
  }

  // Generate a signed URL (valid for 1 hour)
  const { data, error } = await supabase.storage
    .from("commercial-quote-attachments")
    .createSignedUrl(storagePath, 3600);

  if (error || !data?.signedUrl) {
    return Response.json(
      { error: error?.message || "Failed to generate download URL." },
      { status: 400 },
    );
  }

  return Response.json({ url: data.signedUrl });
}
