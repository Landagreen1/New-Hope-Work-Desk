/**
 * Quick script to check actual display_names in the profiles table.
 * Run: node scripts/check-names.mjs
 * Requires .env.local with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), ".env.local");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    }
  } catch { /* ignore */ }
}
loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Missing env vars"); process.exit(1); }

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const { data, error } = await supabase.from("profiles").select("display_name, is_active").eq("is_active", true).order("display_name");
if (error) { console.error(error); process.exit(1); }
console.log("Active profiles (" + data.length + "):");
data.forEach(p => console.log("  " + p.display_name));
