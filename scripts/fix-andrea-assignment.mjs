/**
 * fix-andrea-assignment.mjs
 *
 * Fixes the Trello import that assigned cards to Andrea Rodriguez instead of Andrea Rueda.
 * Moves all commercial_quotes from Andrea Rodriguez to Andrea Rueda.
 *
 * Usage: node scripts/fix-andrea-assignment.mjs
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

// ─── Load env ────────────────────────────────────────────────────────────────
for (const envFile of [".env.local", ".env"]) {
  const envPath = resolve(process.cwd(), envFile);
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* ignore */ }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("Missing SUPABASE env vars"); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  console.log("\n🔧 Fix Andrea Assignment\n");

  // Find both Andreas
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, username, display_name")
    .ilike("display_name", "%andrea%");

  if (profilesError) { console.error("❌ Error fetching profiles:", profilesError.message); process.exit(1); }

  console.log("  Found Andrea profiles:");
  for (const p of profiles) {
    console.log(`    ${p.display_name} (${p.username}) → ${p.id}`);
  }

  const rodriguez = profiles.find(p => p.display_name.toLowerCase().includes("rodriguez"));
  const rueda = profiles.find(p => p.display_name.toLowerCase().includes("rueda"));

  if (!rodriguez) { console.error("❌ Andrea Rodriguez not found!"); process.exit(1); }
  if (!rueda) { console.error("❌ Andrea Rueda not found!"); process.exit(1); }

  console.log(`\n  Source (WRONG): ${rodriguez.display_name} (${rodriguez.id})`);
  console.log(`  Target (CORRECT): ${rueda.display_name} (${rueda.id})`);

  // Count cards currently assigned to Rodriguez
  const { count: rodriguezCount } = await supabase
    .from("commercial_quotes")
    .select("id", { count: "exact", head: true })
    .eq("assigned_to", rodriguez.id)
    .eq("is_deleted", false);

  const { count: ruedaCount } = await supabase
    .from("commercial_quotes")
    .select("id", { count: "exact", head: true })
    .eq("assigned_to", rueda.id)
    .eq("is_deleted", false);

  console.log(`\n  Cards on Rodriguez's board: ${rodriguezCount}`);
  console.log(`  Cards on Rueda's board: ${ruedaCount}`);

  if (!rodriguezCount || rodriguezCount === 0) {
    console.log("\n  ⚠️  No cards to move. Already fixed?");
    return;
  }

  // Move all cards from Rodriguez → Rueda
  console.log(`\n  Moving ${rodriguezCount} cards from Rodriguez → Rueda...`);

  const { error: updateError, count: updatedCount } = await supabase
    .from("commercial_quotes")
    .update({ assigned_to: rueda.id })
    .eq("assigned_to", rodriguez.id)
    .eq("is_deleted", false);

  if (updateError) {
    console.error("❌ Error updating cards:", updateError.message);
    process.exit(1);
  }

  // Also update column_history entries
  const { error: histError } = await supabase
    .from("commercial_quote_column_history")
    .update({ moved_by: rueda.id })
    .eq("moved_by", rodriguez.id);

  if (histError) {
    console.log(`  ⚠️  Column history update failed: ${histError.message} (non-critical)`);
  }

  // Also update attachments uploaded_by
  const { error: attError } = await supabase
    .from("commercial_quote_attachments")
    .update({ uploaded_by: rueda.id })
    .eq("uploaded_by", rodriguez.id);

  if (attError) {
    console.log(`  ⚠️  Attachments update failed: ${attError.message} (non-critical)`);
  }

  // Verify
  const { count: finalRodriguez } = await supabase
    .from("commercial_quotes")
    .select("id", { count: "exact", head: true })
    .eq("assigned_to", rodriguez.id)
    .eq("is_deleted", false);

  const { count: finalRueda } = await supabase
    .from("commercial_quotes")
    .select("id", { count: "exact", head: true })
    .eq("assigned_to", rueda.id)
    .eq("is_deleted", false);

  console.log(`\n✅ Done!`);
  console.log(`  Rodriguez board: ${finalRodriguez} cards`);
  console.log(`  Rueda board: ${finalRueda} cards`);
}

main().catch(err => { console.error("\n❌ Fatal:", err.message); process.exit(1); });
