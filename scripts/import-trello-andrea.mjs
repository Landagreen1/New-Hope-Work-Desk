/**
 * import-trello-andrea.mjs
 *
 * Imports Andrea Rueda's Trello board from CSV export into commercial_quotes.
 * Handles the CSV format (with embedded JSON in columns) and uploads attachments.
 *
 * Usage:
 *   node scripts/import-trello-andrea.mjs
 *
 * Step 1: Import cards (quotes, checklists)
 * Step 2: Upload attachments (run with --attachments flag)
 *
 * Requires .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

// ─── Load env ────────────────────────────────────────────────────────────────
// Try .env.local first, then .env
for (const envFile of [".env.local", ".env"]) {
  const envPath = resolve(process.cwd(), envFile);
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
    break;
  } catch {}
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE env vars"); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// ─── Paths ───────────────────────────────────────────────────────────────────
const CSV_PATH = "C:\\Users\\landa\\Downloads\\export (3)\\Export.csv";
const ATTACHMENTS_DIR = "C:\\Users\\landa\\Downloads\\export (2)";

// ─── Andrea's Board: List ID → board_column ──────────────────────────────────
// Based on the CSV data, we can identify which list IDs map to which columns.
// Board ID: 6a29777dbe61ef11223f8cec
const LIST_MAP = {
  "6a31601e49730c10da98fd47": "quoting",        // Active quoting cards
  "6a31601a0e8e2994a5c5251c": "sold",           // Sold cards (JH Master, Alexander Serrano)
  "6a2982490b7f4ec83af197da": "quote_intake",    // Quote intake / templates
  "6a29777dbe61ef11223f8ceb": "quoting",         // More quoting cards (Drywall Flores, AJ Luxury, etc.)
  "6a29777dbe61ef11223f8ce8": "quoting",         // The Max Builders
  "6a29777dbe61ef11223f8ce9": "not_sold",        // Versatile Metal Works, Mayor Lige, Robert Tyner
};

// ─── Coverage detection ──────────────────────────────────────────────────────
function detectCoverage(name, desc) {
  const text = `${name} ${desc}`.toUpperCase();
  const glNo = /GL:\s*No/i.test(desc);
  const wcNo = /WC:\s*No/i.test(desc);
  const umbNo = /UMB:\s*No/i.test(desc);
  const glYes = /\bGL\b/.test(text) && !glNo;
  const wcYes = /\bWC\b/.test(text) && !wcNo;
  const umbYes = /\bUMB\b/.test(text) && !umbNo;
  if (glYes && wcYes && umbYes) return "gl_wc_umb";
  if (glYes && wcYes) return "gl_wc";
  if (glYes) return "gl";
  if (wcYes) return "wc";
  if (umbYes) return "umb";
  return null;
}

// ─── CSV Parser (handles quoted fields with embedded quotes/newlines) ─────────
function parseCSV(text) {
  const rows = [];
  let i = 0;
  const len = text.length;

  function parseField() {
    if (i >= len || text[i] === '\n' || text[i] === '\r') return "";

    if (text[i] === '"') {
      // Quoted field
      i++; // skip opening quote
      let field = "";
      while (i < len) {
        if (text[i] === '"') {
          if (i + 1 < len && text[i + 1] === '"') {
            // Escaped quote
            field += '"';
            i += 2;
          } else {
            // End of quoted field
            i++; // skip closing quote
            break;
          }
        } else {
          field += text[i];
          i++;
        }
      }
      return field;
    } else {
      // Unquoted field
      let field = "";
      while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
        field += text[i];
        i++;
      }
      return field;
    }
  }

  while (i < len) {
    const row = [];
    while (true) {
      const field = parseField();
      row.push(field);
      if (i >= len || text[i] === '\n' || text[i] === '\r') {
        // End of row
        if (text[i] === '\r' && i + 1 < len && text[i + 1] === '\n') i += 2;
        else if (text[i] === '\n' || text[i] === '\r') i++;
        break;
      }
      if (text[i] === ',') {
        i++; // skip comma
      }
    }
    if (row.length > 1 || (row.length === 1 && row[0] !== "")) {
      rows.push(row);
    }
  }

  return rows;
}

// ─── Mime type detection ─────────────────────────────────────────────────────
function getMimeType(fileName) {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const mimes = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    pdf: "application/pdf", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    mp3: "audio/mpeg", mp4: "video/mp4", eml: "message/rfc822", msg: "application/vnd.ms-outlook",
    txt: "text/plain", csv: "text/csv", xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return mimes[ext] || "application/octet-stream";
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const doAttachments = process.argv.includes("--attachments");

  console.log(`\n📋 Andrea Rueda Trello Import`);
  console.log(`   CSV: ${CSV_PATH}`);
  console.log(`   Mode: ${doAttachments ? "ATTACHMENTS" : "CARDS + CHECKLISTS"}\n`);

  // Parse CSV
  const csvText = await readFile(CSV_PATH, "utf8");
  const rows = parseCSV(csvText);
  const headers = rows[0];
  const dataRows = rows.slice(1);

  console.log(`   Columns: ${headers.length}`);
  console.log(`   Data rows: ${dataRows.length}`);

  // Build header index
  const colIdx = {};
  headers.forEach((h, i) => { colIdx[h] = i; });

  // Load profiles
  const { data: profiles } = await supabase.from("profiles").select("id, username, display_name").eq("is_active", true);
  const profileByUsername = new Map();
  for (const p of profiles) profileByUsername.set(p.username, p);

  // Andrea is the agent for all cards on this board
  const andrea = profileByUsername.get("andrear");
  if (!andrea) { console.error("❌ Profile 'andrear' not found!"); process.exit(1); }
  console.log(`   Assigned to: ${andrea.display_name} (${andrea.username})`);

  if (doAttachments) {
    await importAttachments(dataRows, colIdx, andrea);
  } else {
    await importCards(dataRows, colIdx, andrea);
  }
}

// ─── Import Cards ────────────────────────────────────────────────────────────
async function importCards(dataRows, colIdx, andrea) {
  let imported = 0, skipped = 0;
  const errors = [];

  for (const row of dataRows) {
    const cardId = row[colIdx["id"]];
    const name = (row[colIdx["name"]] || "").trim();
    const desc = row[colIdx["desc"]] || "";
    const closed = row[colIdx["closed"]] === "true";
    const isTemplate = row[colIdx["isTemplate"]] === "true";
    const idList = row[colIdx["idList"]] || "";
    const dateLastActivity = row[colIdx["dateLastActivity"]] || "";
    const checklistsRaw = row[colIdx["checklists"]] || "[]";
    const attachmentsRaw = row[colIdx["attachments"]] || "[]";

    // Skip closed, template, or empty cards
    if (closed || isTemplate || !name) { skipped++; continue; }
    if (name.includes("Quote Template")) { skipped++; continue; }

    // Determine board column
    const boardColumn = LIST_MAP[idList];
    if (!boardColumn) {
      console.log(`   ⚠️  Unknown list ${idList} for card "${name.slice(0, 40)}"`);
      skipped++;
      continue;
    }

    // Coverage type
    const coverageType = detectCoverage(name, desc);

    // Created at — use dateLastActivity as approximation
    const createdAt = dateLastActivity || new Date().toISOString();

    // Insert the quote
    const quoteRow = {
      business_name: name.slice(0, 250),
      description: desc || null,
      board_column: boardColumn,
      column_position: imported + 1,
      risk_level: "medium",
      card_status: "in_progress",
      coverage_type: coverageType,
      assigned_to: andrea.id,
      is_mirrored: true,
      is_deleted: false,
      created_at: createdAt,
      board_entered_at: createdAt,
      column_entered_at: createdAt,
    };

    const { data: insertedQuote, error: insertError } = await supabase
      .from("commercial_quotes")
      .insert(quoteRow)
      .select("id")
      .single();

    if (insertError) {
      errors.push({ card: name, error: insertError.message });
      continue;
    }

    const quoteId = insertedQuote.id;

    // ─── Checklists ────────────────────────────────────────────────────────
    let checklists = [];
    try { checklists = JSON.parse(checklistsRaw); } catch {}

    if (checklists.length > 0) {
      for (const cl of checklists) {
        const { data: insertedCl } = await supabase
          .from("commercial_quote_checklists")
          .insert({ quote_id: quoteId, title: cl.name || "Checklist", position: 0 })
          .select("id")
          .single();

        if (insertedCl && cl.checkItems?.length > 0) {
          const items = cl.checkItems.map((item, idx) => ({
            checklist_id: insertedCl.id,
            label: item.name,
            is_checked: item.state === "complete",
            position: idx + 1,
          }));
          await supabase.from("commercial_quote_checklist_items").insert(items);
        }
      }
    } else {
      // Default checklist
      const { data: defaultCl } = await supabase
        .from("commercial_quote_checklists")
        .insert({ quote_id: quoteId, title: "Required Documents", position: 0 })
        .select("id")
        .single();
      if (defaultCl) {
        await supabase.from("commercial_quote_checklist_items").insert([
          { checklist_id: defaultCl.id, label: "Recording", position: 1 },
          { checklist_id: defaultCl.id, label: "Email", position: 2 },
          { checklist_id: defaultCl.id, label: "Form", position: 3 },
        ]);
      }
    }

    // ─── Column history (synthetic) ────────────────────────────────────────
    const historyEntries = [{
      quote_id: quoteId,
      from_column: null,
      to_column: boardColumn,
      moved_by: andrea.id,
      moved_at: createdAt,
    }];
    await supabase.from("commercial_quote_column_history").insert(historyEntries);

    imported++;
    if (imported % 5 === 0) console.log(`   ... ${imported} imported`);
  }

  console.log(`\n✅ Card import complete`);
  console.log(`   Imported: ${imported}`);
  console.log(`   Skipped:  ${skipped}`);
  if (errors.length > 0) {
    console.log(`   Errors:   ${errors.length}`);
    errors.forEach(e => console.log(`     ❌ ${e.card.slice(0, 40)}: ${e.error}`));
  }
}

// ─── Import Attachments ──────────────────────────────────────────────────────
async function importAttachments(dataRows, colIdx, andrea) {
  console.log(`   Attachments dir: ${ATTACHMENTS_DIR}\n`);

  const BUCKET = "commercial-quote-attachments";

  // Build a map: fileName → [cardName] from the CSV
  const fileToCards = new Map();
  for (const row of dataRows) {
    const name = (row[colIdx["name"]] || "").trim();
    const closed = row[colIdx["closed"]] === "true";
    const isTemplate = row[colIdx["isTemplate"]] === "true";
    if (closed || isTemplate || !name || name.includes("Quote Template")) continue;

    const attachmentsRaw = row[colIdx["attachments"]] || "[]";
    let attachments = [];
    try { attachments = JSON.parse(attachmentsRaw); } catch {}

    for (const att of attachments) {
      const fileName = att.fileName || "";
      if (!fileName) continue;
      if (!fileToCards.has(fileName)) fileToCards.set(fileName, []);
      fileToCards.get(fileName).push({
        cardName: name,
        bytes: att.bytes,
        mimeType: att.mimeType || getMimeType(fileName),
      });
    }
  }

  console.log(`   Unique filenames in CSV: ${fileToCards.size}`);

  // Get disk files
  let diskFiles;
  try {
    diskFiles = await readdir(ATTACHMENTS_DIR);
  } catch (err) {
    console.error(`❌ Cannot read attachments dir: ${err.message}`);
    process.exit(1);
  }
  console.log(`   Files on disk: ${diskFiles.length}`);

  // Load our commercial_quotes to map business_name → quote_id
  // Only get quotes assigned to Andrea that were just imported
  const { data: quotes } = await supabase
    .from("commercial_quotes")
    .select("id, business_name")
    .eq("is_deleted", false)
    .eq("assigned_to", andrea.id);

  const quoteByName = new Map();
  for (const q of quotes) {
    if (!quoteByName.has(q.business_name)) quoteByName.set(q.business_name, q.id);
  }

  console.log(`   Quotes in DB for Andrea: ${quoteByName.size}`);

  let uploaded = 0, skipped = 0, errors = 0;

  for (const fileName of diskFiles) {
    // Try to match the disk file to CSV attachments
    // The disk files may have URL-encoded names or underscored names
    let cardRefs = fileToCards.get(fileName);

    // Try URL-decoded version
    if (!cardRefs) {
      try {
        const decoded = decodeURIComponent(fileName);
        cardRefs = fileToCards.get(decoded);
      } catch {}
    }

    // Try matching with underscore-to-space conversion for encoded files
    if (!cardRefs) {
      // The CSV has filenames like "Confirmaci_C3_B3n_de_..." which are the URL-encoded versions
      // and the disk might have the percent-encoded version or vice versa
      for (const [csvFileName, refs] of fileToCards) {
        // Normalize both for comparison
        const normalizedDisk = fileName.replace(/%[0-9A-Fa-f]{2}/g, m => m.toUpperCase());
        const normalizedCsv = csvFileName.replace(/%[0-9A-Fa-f]{2}/g, m => m.toUpperCase());
        if (normalizedDisk === normalizedCsv) {
          cardRefs = refs;
          break;
        }
      }
    }

    if (!cardRefs || cardRefs.length === 0) {
      skipped++;
      continue;
    }

    // Read the file
    const filePath = join(ATTACHMENTS_DIR, fileName);
    let fileBuffer, fileSize;
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
          uploaded_by: andrea.id,
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

    if (uploaded % 10 === 0 && uploaded > 0) {
      console.log(`   ... ${uploaded} uploaded`);
    }
  }

  console.log(`\n✅ Attachments import complete`);
  console.log(`   Uploaded: ${uploaded}`);
  console.log(`   Skipped:  ${skipped}`);
  console.log(`   Errors:   ${errors}`);
}

main().catch(err => { console.error("\n❌ Fatal:", err.message); process.exit(1); });
