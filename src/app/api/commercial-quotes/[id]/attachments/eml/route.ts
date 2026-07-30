import { canAccessCommercial } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/commercial-quotes/:id/attachments/eml?path=...
 * Parse a .eml attachment and return subject, from, to, date, and body text.
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

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile || !canAccessCommercial(profile.role)) {
    return Response.json(
      { error: "Commercial access required." },
      { status: 403 },
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

  // Verify the attachment belongs to this quote
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

  // Download the raw file
  const { data: fileData, error: dlError } = await supabase.storage
    .from("commercial-quote-attachments")
    .download(storagePath);

  if (dlError || !fileData) {
    return Response.json(
      { error: dlError?.message || "Failed to download EML file." },
      { status: 400 },
    );
  }

  const raw = await fileData.text();

  // Parse the EML (RFC 2822 format)
  const parsed = parseEml(raw);

  return Response.json(parsed);
}

// ─── Lightweight EML Parser ──────────────────────────────────────────────────

interface ParsedEml {
  subject: string;
  from: string;
  to: string;
  date: string;
  body: string;
}

function parseEml(raw: string): ParsedEml {
  // Normalize line endings
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Split headers from body at first blank line
  const splitIndex = normalized.indexOf("\n\n");
  const headerSection = splitIndex >= 0 ? normalized.slice(0, splitIndex) : normalized;
  const bodySection = splitIndex >= 0 ? normalized.slice(splitIndex + 2) : "";

  // Unfold continued headers (lines starting with whitespace are continuations)
  const unfoldedHeaders = headerSection.replace(/\n[ \t]+/g, " ");

  const headers: Record<string, string> = {};
  for (const line of unfoldedHeaders.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      // Keep first occurrence only
      if (!headers[key]) {
        headers[key] = value;
      }
    }
  }

  // Extract plain text body from potentially MIME multipart
  const body = extractPlainText(bodySection, headers["content-type"] ?? "");

  return {
    subject: decodeHeader(headers["subject"] ?? "(No subject)"),
    from: decodeHeader(headers["from"] ?? "Unknown"),
    to: decodeHeader(headers["to"] ?? "Unknown"),
    date: headers["date"] ?? "",
    body: body.slice(0, 50000), // Cap at 50k chars
  };
}

function extractPlainText(body: string, contentType: string): string {
  // If it's a simple text/plain email
  if (
    contentType.includes("text/plain") ||
    (!contentType.includes("multipart") && !contentType.includes("text/html"))
  ) {
    return decodeBody(body, contentType);
  }

  // If multipart, extract boundary and find text/plain part
  const boundaryMatch = contentType.match(/boundary="?([^";\n]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = body.split(`--${boundary}`);

    // First try text/plain
    for (const part of parts) {
      if (part.trim() === "--" || part.trim() === "") continue;
      const partSplit = part.indexOf("\n\n");
      if (partSplit < 0) continue;
      const partHeaders = part.slice(0, partSplit).toLowerCase();
      const partBody = part.slice(partSplit + 2);

      if (partHeaders.includes("text/plain")) {
        return decodeBody(partBody, partHeaders);
      }
    }

    // Fall back to text/html stripped of tags
    for (const part of parts) {
      if (part.trim() === "--" || part.trim() === "") continue;
      const partSplit = part.indexOf("\n\n");
      if (partSplit < 0) continue;
      const partHeaders = part.slice(0, partSplit).toLowerCase();
      const partBody = part.slice(partSplit + 2);

      if (partHeaders.includes("text/html")) {
        return stripHtml(decodeBody(partBody, partHeaders));
      }
    }
  }

  // If it's text/html without multipart
  if (contentType.includes("text/html")) {
    return stripHtml(decodeBody(body, contentType));
  }

  // Fallback: return raw body
  return body;
}

function decodeBody(body: string, headers: string): string {
  // Handle quoted-printable encoding
  if (headers.includes("quoted-printable")) {
    return decodeQuotedPrintable(body);
  }
  // Handle base64
  if (headers.includes("base64")) {
    try {
      const cleaned = body.replace(/[\s]/g, "");
      return Buffer.from(cleaned, "base64").toString("utf-8");
    } catch {
      return body;
    }
  }
  return body;
}

function decodeQuotedPrintable(str: string): string {
  return str
    .replace(/=\n/g, "") // Soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHeader(value: string): string {
  // Decode RFC 2047 encoded words: =?charset?encoding?text?=
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g,
    (_, _charset, encoding, text) => {
      if (encoding.toUpperCase() === "B") {
        try {
          return Buffer.from(text, "base64").toString("utf-8");
        } catch {
          return text;
        }
      }
      if (encoding.toUpperCase() === "Q") {
        return decodeQuotedPrintable(text.replace(/_/g, " "));
      }
      return text;
    }
  );
}
