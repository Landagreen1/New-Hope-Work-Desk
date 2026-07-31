/**
 * Validates that every statement in diagnostics/production-queue-diagnostic.sql
 * parses and executes against the live database. READ-ONLY.
 *
 * Splits the file on top-level semicolons, refuses anything containing a write
 * keyword, then executes each statement and reports row counts / errors.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const root = resolve(import.meta.dirname, "..", "..", "..", "..");
const env = {};
for (const line of readFileSync(resolve(root, ".env.local"), "utf-8").split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}

async function q(sql) {
  const r = await fetch(
    `https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
      body: JSON.stringify({ query: sql }),
    },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(JSON.parse(t).message ?? t);
  return JSON.parse(t);
}

const file = resolve(import.meta.dirname, "..", "diagnostics", "production-queue-diagnostic.sql");
const raw = readFileSync(file, "utf-8");

// Strip line comments, then split on semicolons.
const noComments = raw.replace(/^\s*--.*$/gm, "");
const statements = noComments
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

console.log(`Parsed ${statements.length} statements from production-queue-diagnostic.sql\n`);

let ok = 0;
const failures = [];

for (let i = 0; i < statements.length; i++) {
  const stmt = statements[i];
  const lower = stmt.toLowerCase();
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|begin|commit|rollback)\b/.test(lower)) {
    failures.push({ i: i + 1, err: "CONTAINS WRITE KEYWORD", head: stmt.slice(0, 90) });
    console.log(`[${i + 1}] REFUSED (write keyword): ${stmt.slice(0, 70).replace(/\s+/g, " ")}`);
    continue;
  }
  const head = stmt.replace(/\s+/g, " ").slice(0, 68);
  try {
    const rows = await q(stmt);
    ok++;
    console.log(`[${i + 1}] ok  (${Array.isArray(rows) ? rows.length : 0} rows)  ${head}`);
  } catch (e) {
    failures.push({ i: i + 1, err: String(e.message).slice(0, 220), head });
    console.log(`[${i + 1}] FAIL  ${head}\n        -> ${String(e.message).slice(0, 200)}`);
  }
}

console.log(`\n=== ${ok}/${statements.length} statements executed successfully ===`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  [${f.i}] ${f.err}\n       ${f.head}`);
  process.exitCode = 1;
}
