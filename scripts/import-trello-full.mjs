/**
 * import-trello-full.mjs
 *
 * Full Trello JSON import into commercial_quotes with:
 *   - Proper column mapping
 *   - Synthetic column_history from Trello actions (createCard + updateCard moves)
 *   - Comments with proper author attribution
 *   - Checklists with checked/unchecked state
 *   - Agent assignment from labels
 *
 * Usage:
 *   node scripts/import-trello-full.mjs [path-to-json]
 *
 * Requires .env.local with NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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

// ─── Trello List ID → board_column ──────────────────────────────────────────

const LIST_MAP = {
  "6a283af9e126276ced989add": "quoting",
  "6a286a3145250983893aff74": "sold",
  "6a283b008262839397b90ee7": "sold",
  "6a283b0bedb5f7a69261b035": "not_sold",
  "6a30336342907e50f6ea1f36": "commission_approved",
  "6a30336a988a446b2cb46c49": "commission_not_approved",
  "6a283ae450e71b4e0bda3f5c": "quote_intake",
  "6a296fde52d85ff554fea958": null, // Template
  "6a29633b2cd302ae0ee7330c": "to_do",
  "6a4d5b8ed8c3eaef75e16d89": "archive",
};

const LIST_NAME_MAP = {
  "Quoting": "quoting",
  "Sold!": "sold",
  "Sold": "sold",
  "Not Sold": "not_sold",
  "Commision Approved": "commission_approved",
  "Commision  Not Approved": "commission_not_approved",
  "Quotes": "quote_intake",
  "Quote Information": null,
  "To do!": "to_do",
  "Archive 07/26": "archive",
};

// ─── Label → username ────────────────────────────────────────────────────────

const LABEL_TO_USERNAME = {
  Gabriel: "gabrielz",
  Santiago: "santiagoc",
  Jossue: "josuec",
  Andrea: "andrear",
  Axel: "axelm",
  Diana: "dianav",
};

// ─── Author detection from comment text ──────────────────────────────────────

const NAME_TO_USERNAME = {
  gabriel: "gabrielz", zalazar: "gabrielz",
  jossue: "josuec", cardenas: "josuec",
  axel: "axelm", moreno: "axelm",
  santiago: "santiagoc", cabezas: "santiagoc",
  andrea: "andrear", rodriguez: "andrear",
  diana: "dianav", vazquez: "dianav",
};

function detectCommentAuthor(text) {
  const patterns = [/>\*\*(.+?)\*\*\s+commented from/i, />\s*This is a comment from \*\*(.+?)\*\*/i];
  for (const p of patterns) {
    const match = text.match(p);
    if (match) {
      const name = match[1].toLowerCase();
      for (const [frag, user] of Object.entries(NAME_TO_USERNAME)) {
        if (name.includes(frag)) return user;
      }
    }
  }
  return null;
}

function cleanCommentText(text) {
  return text
    .replace(/^>\*\*.+?\*\*\s+commented from the .+?\n?/i, "")
    .replace(/^>This is a comment from \*\*.+?\*\*\..+?\n?/i, "")
    .replace(/\[learn more\]\(https:\/\/help\.placker\.com.+?\)\n?/gi, "")
    .trim() || text.trim();
}

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
  if (/GARAGE\s*LIABILITY/i.test(text) || /LIQUOR/i.test(text) || /BOND/i.test(text)) return "other";
  return null;
}

// ─── Synthetic pipeline path ─────────────────────────────────────────────────
// For cards without move history, generate a plausible pipeline path

function syntheticPath(finalColumn) {
  // The pipeline goes: quoting → sold/not_sold → commission_approved/not_approved
  const paths = {
    quoting: ["quoting"],
    sold: ["quoting", "sold"],
    not_sold: ["quoting", "not_sold"],
    commission_approved: ["quoting", "sold", "commission_approved"],
    commission_not_approved: ["quoting", "sold", "commission_not_approved"],
    quote_intake: ["quote_intake"],
    archive: ["quoting", "archive"],
  };
  return paths[finalColumn] || [finalColumn];
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const jsonPath = process.argv[2] || "C:\\Users\\Byron\\Desktop\\wYWzty7D - commercial-quotes-new-hope-insurance.json";
  console.log(`\n📋 Full Trello Import (with column history)\n   JSON: ${jsonPath}\n`);

  const json = JSON.parse(await readFile(resolve(jsonPath), "utf8"));
  const openCards = json.cards.filter(c => !c.closed);
  console.log(`   Total cards: ${json.cards.length}, Open: ${openCards.length}`);

  // Load profiles
  const { data: profiles } = await supabase.from("profiles").select("id, username, display_name").eq("is_active", true);
  const profileByUsername = new Map();
  for (const p of profiles) profileByUsername.set(p.username, p);
  const oscar = profileByUsername.get("oscar");

  // Build action maps
  const cardCreates = new Map();
  const cardMoves = new Map();
  const cardComments = new Map();

  for (const a of json.actions) {
    const cardId = a.data?.card?.id;
    if (!cardId) continue;

    if (a.type === "createCard") {
      cardCreates.set(cardId, { listName: a.data.list?.name, listId: a.data.list?.id, date: a.date });
    }
    if (a.type === "updateCard" && a.data.listBefore && a.data.listAfter) {
      if (!cardMoves.has(cardId)) cardMoves.set(cardId, []);
      cardMoves.get(cardId).push({
        fromName: a.data.listBefore.name,
        toName: a.data.listAfter.name,
        date: a.date,
      });
    }
    if (a.type === "commentCard") {
      if (!cardComments.has(cardId)) cardComments.set(cardId, []);
      cardComments.get(cardId).push({ text: a.data.text, date: a.date });
    }
  }

  // Sort moves chronologically per card
  for (const [, moves] of cardMoves) {
    moves.sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  let imported = 0, skipped = 0;
  const errors = [];

  for (const card of openCards) {
    const name = (card.name || "").trim();
    if (!name) { skipped++; continue; }

    // Skip template cards
    if (name.includes("Quote Template")) { skipped++; continue; }

    // Determine board column
    const boardColumn = LIST_MAP[card.idList];
    if (boardColumn === null || boardColumn === undefined) { skipped++; continue; }

    // Detect agent from labels
    let assignedProfile = oscar;
    for (const label of (card.labels || [])) {
      const username = LABEL_TO_USERNAME[label.name];
      if (username && profileByUsername.has(username)) {
        assignedProfile = profileByUsername.get(username);
        break;
      }
    }

    // Coverage type
    const coverageType = detectCoverage(name, card.desc || "");

    // Determine card creation date
    const createEvent = cardCreates.get(card.id);
    const createdAt = createEvent?.date || card.dateLastActivity || new Date().toISOString();

    // Determine commission status
    let commissionStatus = null;
    let commissionNotes = null;
    if (boardColumn === "commission_approved") {
      commissionStatus = "approved";
      commissionNotes = "Imported from Trello";
    } else if (boardColumn === "commission_not_approved") {
      commissionStatus = "denied";
      commissionNotes = "Imported from Trello";
    }

    // Insert the quote
    const quoteRow = {
      business_name: name.slice(0, 250),
      description: card.desc || null,
      board_column: boardColumn,
      column_position: imported + 1,
      risk_level: "medium",
      card_status: "in_progress",
      coverage_type: coverageType,
      assigned_to: assignedProfile.id,
      is_mirrored: true,
      is_deleted: false,
      commission_status: commissionStatus,
      commission_notes: commissionNotes,
      created_at: createdAt,
      board_entered_at: createdAt,
      column_entered_at: card.dateLastActivity || createdAt,
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

    // ─── Generate column_history ───────────────────────────────────────────
    const historyEntries = [];
    const moves = cardMoves.get(card.id) || [];

    if (moves.length > 0) {
      // We have real move events — use them
      // First, add the initial creation move
      const firstMoveFrom = LIST_NAME_MAP[moves[0].fromName];
      if (firstMoveFrom && createEvent) {
        historyEntries.push({
          quote_id: quoteId,
          from_column: null,
          to_column: firstMoveFrom,
          moved_by: assignedProfile.id,
          moved_at: createdAt,
        });
      }
      // Add each move
      for (const move of moves) {
        const from = LIST_NAME_MAP[move.fromName];
        const to = LIST_NAME_MAP[move.toName];
        if (from && to) {
          historyEntries.push({
            quote_id: quoteId,
            from_column: from,
            to_column: to,
            moved_by: assignedProfile.id,
            moved_at: move.date,
          });
        }
      }
    } else {
      // No move events — synthesize based on the card's current column
      const path = syntheticPath(boardColumn);
      const totalDuration = new Date(card.dateLastActivity || createdAt).getTime() - new Date(createdAt).getTime();
      const stepDuration = path.length > 1 ? totalDuration / (path.length - 1) : 0;

      for (let i = 0; i < path.length; i++) {
        const moveDate = new Date(new Date(createdAt).getTime() + stepDuration * i).toISOString();
        historyEntries.push({
          quote_id: quoteId,
          from_column: i === 0 ? null : path[i - 1],
          to_column: path[i],
          moved_by: assignedProfile.id,
          moved_at: moveDate,
        });
      }
    }

    if (historyEntries.length > 0) {
      await supabase.from("commercial_quote_column_history").insert(historyEntries);
    }

    // ─── Checklists ────────────────────────────────────────────────────────
    const checklists = card.checklists || [];
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

    // ─── Comments ──────────────────────────────────────────────────────────
    const comments = cardComments.get(card.id) || [];
    if (comments.length > 0) {
      // Sort oldest first
      comments.sort((a, b) => new Date(a.date) - new Date(b.date));

      for (const comment of comments) {
        const authorUsername = detectCommentAuthor(comment.text);
        // Fallback: use card label owner, then oscar
        const authorProfile = authorUsername
          ? (profileByUsername.get(authorUsername) || assignedProfile)
          : assignedProfile;

        const cleanedText = cleanCommentText(comment.text);
        if (!cleanedText) continue;

        await supabase.from("commercial_quote_comments").insert({
          quote_id: quoteId,
          author_id: authorProfile.id,
          content: cleanedText,
          created_at: comment.date,
        });
      }
    }

    imported++;
    if (imported % 25 === 0) console.log(`   ... ${imported} imported`);
  }

  console.log(`\n✅ Import complete`);
  console.log(`   Imported: ${imported}`);
  console.log(`   Skipped:  ${skipped}`);
  if (errors.length > 0) {
    console.log(`   Errors:   ${errors.length}`);
    errors.slice(0, 5).forEach(e => console.log(`     ❌ ${e.card.slice(0, 40)}: ${e.error}`));
  }

  // Verify column_history
  const { count: histCount } = await supabase.from("commercial_quote_column_history").select("*", { count: "exact", head: true });
  const { count: commentCount } = await supabase.from("commercial_quote_comments").select("*", { count: "exact", head: true });
  console.log(`\n   Column history entries: ${histCount}`);
  console.log(`   Comments imported: ${commentCount}`);
}

main().catch(err => { console.error("\n❌ Fatal:", err.message); process.exit(1); });
