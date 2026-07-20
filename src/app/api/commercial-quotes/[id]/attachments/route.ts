import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/commercial-quotes/:id/attachments
 * List all attachments on a commercial quote card.
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
    .from("commercial_quote_attachments")
    .select(
      `id, file_name, file_size, mime_type, storage_path, created_at,
      profiles!commercial_quote_attachments_uploaded_by_fkey(display_name)`
    )
    .eq("quote_id", id)
    .order("created_at", { ascending: false });

  if (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ attachments: data ?? [] });
}

/**
 * POST /api/commercial-quotes/:id/attachments
 * Upload a file attachment to a commercial quote card.
 * Expects multipart/form-data with a "file" field.
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

  // Parse multipart form data
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json(
      { error: "Invalid form data. Use multipart/form-data with a 'file' field." },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return Response.json(
      { error: "A file is required." },
      { status: 400 },
    );
  }

  if (file.size === 0) {
    return Response.json(
      { error: "File is empty." },
      { status: 400 },
    );
  }

  // 100 MB limit
  if (file.size > 104857600) {
    return Response.json(
      { error: "File exceeds the 100 MB size limit." },
      { status: 400 },
    );
  }

  // Generate a unique storage path: commercial-quote-attachments/{quote_id}/{timestamp}_{filename}
  const timestamp = Date.now();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${id}/${timestamp}_${safeName}`;

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from("commercial-quote-attachments")
    .upload(storagePath, file, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });

  if (uploadError) {
    return Response.json(
      { error: `Upload failed: ${uploadError.message}` },
      { status: 400 },
    );
  }

  // Record the attachment metadata
  const { data, error } = await supabase
    .from("commercial_quote_attachments")
    .insert({
      quote_id: id,
      uploaded_by: user.id,
      file_name: file.name,
      file_size: file.size,
      mime_type: file.type || "application/octet-stream",
      storage_path: storagePath,
    })
    .select("id, file_name, file_size, mime_type, storage_path, created_at")
    .single();

  if (error) {
    // Cleanup: delete the uploaded file if metadata insert fails
    await supabase.storage
      .from("commercial-quote-attachments")
      .remove([storagePath]);
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ attachment: data }, { status: 201 });
}

/**
 * DELETE /api/commercial-quotes/:id/attachments
 * Delete an attachment. Body: { attachment_id: string }
 */
export async function DELETE(request: Request, context: RouteContext) {
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

  const attachmentId = String(body.attachment_id ?? "").trim();
  if (!attachmentId) {
    return Response.json(
      { error: "attachment_id is required." },
      { status: 400 },
    );
  }

  // Get the attachment to find its storage path
  const { data: attachment, error: fetchError } = await supabase
    .from("commercial_quote_attachments")
    .select("id, storage_path")
    .eq("id", attachmentId)
    .eq("quote_id", id)
    .single();

  if (fetchError || !attachment) {
    return Response.json({ error: "Attachment not found." }, { status: 404 });
  }

  // Delete from storage
  await supabase.storage
    .from("commercial-quote-attachments")
    .remove([attachment.storage_path]);

  // Delete metadata record
  const { error: deleteError } = await supabase
    .from("commercial_quote_attachments")
    .delete()
    .eq("id", attachmentId);

  if (deleteError) {
    return Response.json({ error: deleteError.message }, { status: 400 });
  }

  return Response.json({ success: true });
}
