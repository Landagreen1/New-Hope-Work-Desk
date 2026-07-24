/**
 * import-trello-to-commercial-quotes.mjs
 *
 * Imports a Trello board CSV export into the commercial_quotes table.
 *
 * Usage:
 *   node scripts/import-trello-to-commercial-quotes.mjs [path-to-csv]
 *
 * Requires .env.local with:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)
 *
 * What it does:
 *   1. Parses each Trello card from the CSV
 *   2. Maps Trello list IDs → board_column values
 *   3. Maps Trello labels → agent profile IDs (looked up from DB)
 *   4. Parses the card description to detect coverage type (GL, WC, UMB combos)
 *   5. Inserts into commercial_quotes + creates checklists with item states
 *   6. Skips the Quote Template card and empty/duplicate placeholder cards
 *
 * DRY RUN: Set DRY_RUN=1 to see what would be inserted without writing to DB.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";

// ─── Config ──────────────────────────────────────────────────────────────────

const DRY_RUN = process.env.DRY_RUN === "1";

// Load env from .env.local
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
} catch {
  // .env.local not found, rely on existing env vars
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ─── Trello List ID → board_column mapping ───────────────────────────────────
// These were identified from the CSV export's idList values.
// Adjust if your Trello board has different list IDs.

const LIST_MAP = {
  "6a283af9e126276ced989add": "quoting", // Quoting
  "6a286a3145250983893aff74": "sold", // Sold!
  "6a283b0bedb5f7a69261b035": "not_sold", // Not Sold
  "6a30336342907e50f6ea1f36": "commission_approved", // Commission Approved
  "6a30336a988a446b2cb46c49": "commission_not_approved", // Commission Not Approved
  "6a283ae450e71b4e0bda3f5c": "quote_intake", // Quotes (intake)
  "6a283b008262839397b90ee7": "sold", // Sold (old list)
  "6a296fde52d85ff554fea958": null, // Quote Information / Template (skip)
  "6a29633b2cd302ae0ee7330c": "to_do", // To do!
  "6a4d5b8ed8c3eaef75e16d89": "archive", // Archive
};

// ─── Trello Label Name → agent username mapping ──────────────────────────────

const LABEL_TO_USERNAME = {
  Gabriel: null, // No longer in system — will use fallback (Oscar/super_admin)
  Santiago: "santiagoc",
  Jossue: null, // No longer in system — will use fallback
  Andrea: "andrear",
  Axel: null, // No longer in system — will use fallback
  Diana: "dianav",
};

// ─── Coverage detection from description ─────────────────────────────────────

function detectCoverageType(name, desc) {
  const text = `${name} ${desc}`.toUpperCase();

  const hasGL =
    text.includes("GL:") ||
    text.includes("GL ") ||
    text.includes(" GL") ||
    /\bGL\b/.test(text);
  const hasWC =
    text.includes("WC:") ||
    text.includes("WC ") ||
    text.includes(" WC") ||
    /\bWC\b/.test(text);
  const hasUMB =
    text.includes("UMB:") ||
    text.includes("UMB ") ||
    text.includes(" UMB") ||
    /\bUMB\b/.test(text);

  // Check if explicitly "No" for each
  const glNo = /GL:\s*No/i.test(desc);
  const wcNo = /WC:\s*No/i.test(desc);
  const umbNo = /UMB:\s*No/i.test(desc);

  const glYes = hasGL && !glNo;
  const wcYes = hasWC && !wcNo;
  const umbYes = hasUMB && !umbNo;

  if (glYes && wcYes && umbYes) return "gl_wc_umb";
  if (glYes && wcYes) return "gl_wc";
  if (glYes) return "gl";
  if (wcYes) return "wc";
  if (umbYes) return "umb";

  // Check for special types
  if (/GARAGE\s*LIABILITY/i.test(text)) return "other";
  if (/LIQUOR/i.test(text)) return "other";
  if (/BOND/i.test(text)) return "other";
  if (/INM|INLAND\s*MARINE/i.test(text)) return "other";

  return null;
}

// ─── Parse checklist items from JSON ─────────────────────────────────────────

function parseChecklists(checklistsJson) {
  if (!checklistsJson || checklistsJson === "[]") return [];

  let checklists;
  try {
    checklists = JSON.parse(checklistsJson);
  } catch {
    return [];
  }

  return checklists.map((cl) => ({
    title: cl.name || "Checklist",
    items: (cl.checkItems || []).map((item) => ({
      label: item.name,
      isChecked: item.state === "complete",
    })),
  }));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const csvPath = process.argv[2] || "Export.csv";
  const resolvedCsvPath = resolve(process.cwd(), csvPath);

  console.log(`\n📋 Trello → Commercial Quotes Import`);
  console.log(`   CSV: ${resolvedCsvPath}`);
  if (DRY_RUN) console.log("   ⚠️  DRY RUN — no data will be written\n");
  else console.log("");

  // Read & parse CSV
  const csvContent = await readFile(resolvedCsvPath, "utf8");
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  console.log(`   Found ${records.length} cards in CSV`);

  // Look up agent profiles from DB
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, username, display_name")
    .eq("is_active", true);

  if (profilesError) {
    console.error("Failed to fetch profiles:", profilesError.message);
    process.exit(1);
  }

  const profileByUsername = new Map();
  for (const p of profiles) {
    profileByUsername.set(p.username, p);
  }

  // Find a fallback profile (manager/oscar) for cards without a label
  const fallbackProfile =
    profileByUsername.get("oscar") ||
    profileByUsername.get("byron") ||
    profiles[0];

  if (!fallbackProfile) {
    console.error("No profiles found in database. Run bootstrap-users first.");
    process.exit(1);
  }

  console.log(
    `   Found ${profiles.length} profiles. Fallback: ${fallbackProfile.display_name}`
  );

  // Process cards
  let imported = 0;
  let skipped = 0;
  const errors = [];

  for (const row of records) {
    const cardName = row.name || "";
    const idList = row.idList || "";
    const desc = row.desc || "";
    const dateLastActivity = row.dateLastActivity || null;
    const isClosed = row.closed === "true";
    const isTemplate = row.isTemplate === "true";

    // Skip template cards
    if (isTemplate) {
      skipped++;
      continue;
    }

    // Skip the "Quote Template GL/WC/UMB" card
    if (cardName.includes("Quote Template")) {
      skipped++;
      continue;
    }

    // Map list to board_column
    const boardColumn = LIST_MAP[idList];
    if (boardColumn === null) {
      // Template list — skip
      skipped++;
      continue;
    }
    if (!boardColumn) {
      // Unknown list — default to quote_intake
      console.warn(`   ⚠️  Unknown list ${idList} for "${cardName}" → quote_intake`);
    }

    // Skip cards with no business name (empty/placeholder cards)
    if (!cardName.trim()) {
      skipped++;
      continue;
    }

    // Detect agent from labels
    let assignedProfile = fallbackProfile;
    try {
      const labelsJson = row.labels;
      if (labelsJson && labelsJson !== "[]") {
        const labels = JSON.parse(labelsJson);
        for (const label of labels) {
          const username = LABEL_TO_USERNAME[label.name];
          if (username && profileByUsername.has(username)) {
            assignedProfile = profileByUsername.get(username);
            break;
          }
        }
      }
    } catch {
      // Labels parse failed, use fallback
    }

    // Detect coverage type
    const coverageType = detectCoverageType(cardName, desc);

    // Determine card_status based on checklist completion
    let cardStatus = "in_progress";
    if (isClosed) cardStatus = "done";

    // Parse checklists
    const checklists = parseChecklists(row.checklists);

    // Build the insert row
    const quoteRow = {
      business_name: cardName.trim().slice(0, 250),
      description: desc || null,
      board_column: boardColumn || "quote_intake",
      column_position: imported + 1,
      risk_level: "medium",
      card_status: cardStatus,
      coverage_type: coverageType,
      assigned_to: assignedProfile.id,
      is_mirrored: true,
      is_deleted: false,
      created_at: dateLastActivity || new Date().toISOString(),
      board_entered_at: dateLastActivity || new Date().toISOString(),
      column_entered_at: dateLastActivity || new Date().toISOString(),
    };

    if (DRY_RUN) {
      console.log(
        `   [DRY] ${cardName.slice(0, 40).padEnd(40)} → ${boardColumn || "quote_intake"} (${assignedProfile.display_name}, ${coverageType || "unknown"})`
      );
      imported++;
      continue;
    }

    // Insert quote
    const { data: insertedQuote, error: insertError } = await supabase
      .from("commercial_quotes")
      .insert(quoteRow)
      .select("id")
      .single();

    if (insertError) {
      errors.push({ card: cardName, error: insertError.message });
      continue;
    }

    // Insert checklists + items
    for (const cl of checklists) {
      const { data: insertedCl, error: clError } = await supabase
        .from("commercial_quote_checklists")
        .insert({
          quote_id: insertedQuote.id,
          title: cl.title,
          position: 0,
        })
        .select("id")
        .single();

      if (clError || !insertedCl) continue;

      const checklistItems = cl.items.map((item, idx) => ({
        checklist_id: insertedCl.id,
        label: item.label,
        is_checked: item.isChecked,
        position: idx + 1,
      }));

      if (checklistItems.length > 0) {
        await supabase
          .from("commercial_quote_checklist_items")
          .insert(checklistItems);
      }
    }

    // If no checklists from Trello, create the default one
    if (checklists.length === 0) {
      const { data: defaultCl } = await supabase
        .from("commercial_quote_checklists")
        .insert({
          quote_id: insertedQuote.id,
          title: "Required Documents",
          position: 0,
        })
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

    imported++;

    // Progress indicator
    if (imported % 20 === 0) {
      console.log(`   ... ${imported} imported so far`);
    }
  }

  // Summary
  console.log(`\n✅ Import complete`);
  console.log(`   Imported: ${imported}`);
  console.log(`   Skipped:  ${skipped}`);
  if (errors.length > 0) {
    console.log(`   Errors:   ${errors.length}`);
    for (const e of errors.slice(0, 10)) {
      console.log(`     ❌ ${e.card.slice(0, 40)}: ${e.error}`);
    }
    if (errors.length > 10) {
      console.log(`     ... and ${errors.length - 10} more`);
    }
  }
}

main().catch((err) => {
  console.error("\n❌ Fatal error:", err.message);
  process.exit(1);
});
