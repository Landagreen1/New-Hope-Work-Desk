/**
 * import-trello-attachments.mjs
 *
 * Uploads attachment files from Trello export to Supabase Storage,
 * then links them to the correct commercial_quote card.
 *
 * Usage:
 *   node scripts/import-trello-attachments.mjs
 *
 * Expects:
 *   - Trello JSON at: C:\Users\Byron\Desktop\wYWzty7D - commercial-quotes-new-hope-insurance.json
 *   - Attachment files at: C:\Users\Byron\Desktop\attachments\
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

// ─── Load env ────────────────────────────────────────────────────────────────
const envPath = resolve(process.cwd(), ".env.local");
try {
  const envContent = await readFile(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE env vars"); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const ATTACHMENTS_DIR = "C:\\Users\\Byron\\Desktop\\attachments";
const JSON_PATH = "C:\\Users\\Byron\\Desktop\\wYWzty7D - commercial-quotes-new-hope-insurance.json";
const BUCKET = "commercial-quote-attachments";

// Mime type detection from extension
function getMimeType(fileName) {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const mimes = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    mp3: "audio/mpeg", mp4: "video/mp4", eml: "message/rfc822", msg: "application/vnd.ms-outlook",
    txt: "text/plain", csv: "text/csv", xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return mimes[ext] || "application/octet-stream";
}

async function main() {
  console.log(`\n📎 Trello Attachments Import\n`);

  // Load Trello JSON
  const json = JSON.parse(await readFile(JSON_PATH, "utf8"));
  const openCards = json.cards.filter(c => !c.closed);

  // Build map: fileName → [{ cardId, cardName, bytes, mimeType }]
  // Only for open cards that were imported
  const fileToCards = new Map();
  for (const card of openCards) {
    if (card.name?.includes("Quote Template")) continue;
    for (const att of (card.attachments || [])) {
      if (!att.fileName) continue;
      if (!fileToCards.has(att.fileName)) fileToCards.set(att.fileName, []);
      fileToCards.get(att.fileName).push({
        cardId: card.id,
        cardName: card.name,
        bytes: att.bytes,
        mimeType: att.mimeType || getMimeType(att.fileName),
      });
    }
  }

  // Get disk files
  const diskFiles = await readdir(ATTACHMENTS_DIR);
  console.log(`   Files on disk: ${diskFiles.length}`);
  console.log(`   Unique filenames in JSON: ${fileToCards.size}`);

  // Load our commercial_quotes to map business_name → quote_id
  const { data: quotes } = await supabase.from("commercial_quotes").select("id, business_name").eq("is_deleted", false);
  const quoteByName = new Map();
  for (const q of quotes) {
    // Store all (for duplicates, use first)
    if (!quoteByName.has(q.business_name)) quoteByName.set(q.business_name, q.id);
  }

  // Get a fallback user for uploaded_by
  const { data: profiles } = await supabase.from("profiles").select("id, username").eq("username", "oscar").limit(1);
  const uploaderId = profiles?.[0]?.id;
  if (!uploaderId) { console.error("No oscar profile found"); process.exit(1); }

  let uploaded = 0, skipped = 0, errors = 0;

  for (const fileName of diskFiles) {
    const cardRefs = fileToCards.get(fileName);

    if (!cardRefs || cardRefs.length === 0) {
      // File not referenced by any open card
      skipped++;
      continue;
    }

    // For files referenced by multiple cards, upload to each
    const filePath = join(ATTACHMENTS_DIR, fileName);
    let fileBuffer;
    let fileSize;
    try {
      fileBuffer = await readFile(filePath);
      const fileStat = await stat(filePath);
      fileSize = fileStat.size;
    } catch {
      errors++;
      continue;
    }

    const mimeType = getMimeType(fileName);

    for (const ref of cardRefs) {
      // Find our quote by card name
      const quoteId = quoteByName.get(ref.cardName?.trim());
      if (!quoteId) {
        skipped++;
        continue;
      }

      // Upload to Supabase Storage
      const storagePath = `${quoteId}/${Date.now()}-${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, fileBuffer, {
          contentType: mimeType,
          upsert: false,
        });

      if (uploadError) {
        if (uploadError.message?.includes("already exists")) {
          skipped++;
        } else {
          errors++;
          if (errors <= 5) console.log(`   ❌ Upload error for ${fileName}: ${uploadError.message}`);
        }
        continue;
      }

      // Insert attachment record
      const { error: insertError } = await supabase
        .from("commercial_quote_attachments")
        .insert({
          quote_id: quoteId,
          uploaded_by: uploaderId,
          file_name: fileName,
          file_size: fileSize,
          mime_type: mimeType,
          storage_path: storagePath,
        });

      if (insertError) {
        errors++;
        if (errors <= 5) console.log(`   ❌ Insert error for ${fileName}: ${insertError.message}`);
        continue;
      }

      uploaded++;
    }

    if (uploaded % 50 === 0 && uploaded > 0) {
      console.log(`   ... ${uploaded} uploaded`);
    }
  }

  console.log(`\n✅ Attachments import complete`);
  console.log(`   Uploaded: ${uploaded}`);
  console.log(`   Skipped:  ${skipped}`);
  console.log(`   Errors:   ${errors}`);
}

main().catch(err => { console.error("\n❌ Fatal:", err.message); process.exit(1); });
