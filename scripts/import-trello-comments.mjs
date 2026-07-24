/**
 * import-trello-comments.mjs
 *
 * Imports comments from a Trello JSON export into commercial_quote_comments.
 * Attributes comments to the correct agent based on Placker mirror patterns.
 *
 * Usage:
 *   node scripts/import-trello-comments.mjs [path-to-json]
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
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE env vars in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ─── Author detection from comment text ──────────────────────────────────────

const AUTHOR_PATTERNS = [
  // Pattern 1: >**Full Name** commented from the **Board Name** board.
  />\*\*(.+?)\*\*\s+commented from the/i,
  // Pattern 2: >This is a comment from **Full Name**.
  />\s*This is a comment from \*\*(.+?)\*\*/i,
];

// Map display name fragments to usernames
const NAME_TO_USERNAME = {
  gabriel: "gabrielz",
  zalazar: "gabrielz",
  jossue: "josuec",
  cardenas: "josuec",
  axel: "axelm",
  moreno: "axelm",
  santiago: "santiagoc",
  cabezas: "santiagoc",
  andrea: "andrear",
  rodriguez: "andrear",
  diana: "dianav",
  vazquez: "dianav",
};

function detectAuthorUsername(text) {
  for (const pattern of AUTHOR_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const fullName = match[1].toLowerCase();
      for (const [fragment, username] of Object.entries(NAME_TO_USERNAME)) {
        if (fullName.includes(fragment)) return username;
      }
    }
  }
  return null;
}

// Strip the Placker mirror header from comment text to get clean content
function cleanCommentText(text) {
  // Remove the >**Name** commented from... line and the [learn more] link line
  let cleaned = text
    .replace(/^>\*\*.+?\*\*\s+commented from the .+?\n?/i, "")
    .replace(/^>This is a comment from \*\*.+?\*\*\..+?\n?/i, "")
    .replace(/\[learn more\]\(https:\/\/help\.placker\.com.+?\)\n?/gi, "")
    .trim();
  return cleaned || text.trim();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const jsonPath =
    process.argv[2] ||
    "C:\\Users\\Byron\\Desktop\\wYWzty7D - commercial-quotes-new-hope-insurance.json";
  const resolvedPath = resolve(process.cwd(), jsonPath);

  console.log(`\n💬 Trello Comments Import`);
  console.log(`   JSON: ${resolvedPath}\n`);

  const json = JSON.parse(await readFile(resolvedPath, "utf8"));

  // Get all commentCard actions
  const comments = (json.actions || []).filter(
    (a) => a.type === "commentCard"
  );
  console.log(`   Found ${comments.length} comments in JSON`);

  // Load profiles
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, username, display_name")
    .eq("is_active", true);

  const profileByUsername = new Map();
  for (const p of profiles) {
    profileByUsername.set(p.username, p);
  }
  const oscar = profileByUsername.get("oscar");

  // Load existing commercial_quotes to map Trello card IDs to our quote IDs
  // We'll match by business_name since we don't store Trello card IDs
  const { data: quotes } = await supabase
    .from("commercial_quotes")
    .select("id, business_name")
    .eq("is_deleted", false);

  // Build a map: business_name → quote_id (first match)
  const quoteByName = new Map();
  for (const q of quotes) {
    // Store only the first (won't overwrite duplicates, some cards share names)
    if (!quoteByName.has(q.business_name)) {
      quoteByName.set(q.business_name, q.id);
    }
  }

  // Also build a Trello card ID → card name map from the JSON
  const cardNameById = new Map();
  for (const card of json.cards || []) {
    cardNameById.set(card.id, (card.name || "").trim());
  }

  // Also build card ID → label names for fallback author detection
  const cardLabelById = new Map();
  for (const card of json.cards || []) {
    const labels = (card.labels || card.idLabels || []);
    if (Array.isArray(labels) && labels.length > 0) {
      // labels can be objects or strings
      const labelName = typeof labels[0] === "object" ? labels[0].name : null;
      if (labelName) {
        const username = NAME_TO_USERNAME[labelName.toLowerCase()];
        if (username) cardLabelById.set(card.id, username);
      }
    }
  }

  let imported = 0;
  let skipped = 0;
  const errors = [];

  // Sort comments oldest first so they appear in chronological order
  comments.sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const action of comments) {
    const cardId = action.data?.card?.id;
    const cardName = cardNameById.get(cardId) || action.data?.card?.name || "";
    const text = action.data?.text || "";
    const date = action.date;

    if (!cardName.trim() || !text.trim()) {
      skipped++;
      continue;
    }

    // Find the quote in our DB
    const quoteId = quoteByName.get(cardName.trim());
    if (!quoteId) {
      // Try without trim variations
      skipped++;
      continue;
    }

    // Detect real author from comment text
    let authorUsername = detectAuthorUsername(text);
    // Fallback: use the card's label
    if (!authorUsername) {
      authorUsername = cardLabelById.get(cardId);
    }

    const authorProfile = authorUsername
      ? profileByUsername.get(authorUsername)
      : oscar;
    const authorId = (authorProfile || oscar).id;

    // Clean comment text
    const cleanedText = cleanCommentText(text);

    if (!cleanedText) {
      skipped++;
      continue;
    }

    // Insert comment
    const { error } = await supabase.from("commercial_quote_comments").insert({
      quote_id: quoteId,
      author_id: authorId,
      content: `[Imported from Trello] ${cleanedText}`,
      created_at: date,
    });

    if (error) {
      errors.push({ card: cardName.slice(0, 30), error: error.message });
    } else {
      imported++;
    }

    if (imported % 50 === 0 && imported > 0) {
      console.log(`   ... ${imported} comments imported`);
    }
  }

  console.log(`\n✅ Comments import complete`);
  console.log(`   Imported: ${imported}`);
  console.log(`   Skipped:  ${skipped} (no matching quote or empty)`);
  if (errors.length > 0) {
    console.log(`   Errors:   ${errors.length}`);
    for (const e of errors.slice(0, 5)) {
      console.log(`     ❌ ${e.card}: ${e.error}`);
    }
  }
}

main().catch((err) => {
  console.error("\n❌ Fatal error:", err.message);
  process.exit(1);
});
