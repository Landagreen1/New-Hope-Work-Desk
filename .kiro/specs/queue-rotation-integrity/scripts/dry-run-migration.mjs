/**
 * DRY RUN of v1.8.7-fix-rotation-integrity.sql against the live database.
 *
 * The migration is executed with its trailing `commit;` replaced by `rollback;`.
 * PostgreSQL DDL is transactional, so every CREATE OR REPLACE FUNCTION, GRANT
 * and REVOKE is undone when the transaction rolls back. Nothing persists.
 *
 * This validates, for real:
 *   - SQL syntax and plpgsql compilation of every function body
 *   - the preflight guard (section 0)
 *   - the post-install verification block (section 13)
 *   - that all referenced tables, columns, types and helper functions exist
 *
 * It intentionally performs NO data statements: the migration only replaces
 * functions. Queue state, quotes, intakes and audit rows are untouched.
 *
 * Usage: node .kiro/specs/queue-rotation-integrity/scripts/dry-run-migration.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const root = resolve(import.meta.dirname, "..", "..", "..", "..");
const env = {};
for (const line of readFileSync(resolve(root, ".env.local"), "utf-8").split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}

const migrationPath = resolve(
  root,
  "supabase/migrations/v1.8.7-fix-rotation-integrity.sql",
);
const original = readFileSync(migrationPath, "utf-8");

// ── Safety checks on the migration text before we send anything ──────────────
const codeOnly = original
  .split("\n")
  .map((l) => {
    const i = l.indexOf("--");
    return i === -1 ? l : l.slice(0, i);
  })
  .join("\n")
  .toLowerCase();

for (const banned of [
  /\bdrop\s+table\b/,
  /\btruncate\b/,
  /\bdelete\s+from\b/,
  /\bdrop\s+schema\b/,
  /\bdrop\s+database\b/,
  /\balter\s+table\b/,
]) {
  if (banned.test(codeOnly)) {
    console.error(`REFUSING: migration contains a destructive statement: ${banned}`);
    process.exit(1);
  }
}

const commitMatches = codeOnly.match(/^\s*commit;/gm) ?? [];
if (commitMatches.length !== 1) {
  console.error(
    `REFUSING: expected exactly one top-level 'commit;', found ${commitMatches.length}. ` +
      `Cannot safely convert to a rollback.`,
  );
  process.exit(1);
}

// ── Convert the single trailing commit into a rollback ───────────────────────
const dryRun = original.replace(/^([ \t]*)commit;[ \t]*$/m, "$1rollback;");
if (dryRun === original || !/^\s*rollback;/m.test(dryRun)) {
  console.error("REFUSING: failed to substitute commit -> rollback.");
  process.exit(1);
}
if (/^\s*commit;/m.test(
  dryRun.split("\n").map((l) => { const i = l.indexOf("--"); return i === -1 ? l : l.slice(0, i); }).join("\n"),
)) {
  console.error("REFUSING: a commit; still remains after substitution.");
  process.exit(1);
}

console.log("Migration : supabase/migrations/v1.8.7-fix-rotation-integrity.sql");
console.log(`Length    : ${original.length} chars`);
console.log("Mode      : DRY RUN (commit -> rollback; nothing persists)");
console.log("---");

async function q(sql) {
  const r = await fetch(
    `https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

// ── Capture the "before" fingerprint of every function we replace ────────────
const FN_LIST = `
  'next_eligible_profile','is_rotation_eligible','rotation_position_of',
  'rotation_empty_reason','advance_rotation','ensure_rotation_valid',
  'pass_my_turn','set_my_availability','manager_set_rotation_eligibility',
  'claim_timed_quote','steal_timed_quote'
`;
const fingerprintSql = `
  select p.proname, md5(pg_get_functiondef(p.oid)) as body_md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname in (${FN_LIST})
  order by p.proname, body_md5;
`;

const before = await q(fingerprintSql);
if (!before.ok) {
  console.error("Could not capture pre-state:", before.text.slice(0, 300));
  process.exit(1);
}
const beforeRows = JSON.parse(before.text);
console.log(`Pre-state : ${beforeRows.length} of 11 target functions currently exist`);

// ── Execute the dry run ─────────────────────────────────────────────────────
const result = await q(dryRun);

let verdict;
if (result.ok) {
  verdict = "PASS";
  console.log("\nDRY RUN RESULT: PASS");
  console.log("  The full migration compiled and executed, the preflight guard");
  console.log("  passed, and the post-install verification block passed.");
  console.log("  The transaction was then rolled back.");
} else {
  verdict = "FAIL";
  console.log("\nDRY RUN RESULT: FAIL");
  let msg = result.text;
  try {
    msg = JSON.parse(result.text).message ?? result.text;
  } catch {
    /* keep raw */
  }
  console.log(`  HTTP ${result.status}`);
  console.log(`  ${String(msg).slice(0, 1500)}`);
}

// ── Confirm nothing persisted ───────────────────────────────────────────────
const after = await q(fingerprintSql);
const afterRows = after.ok ? JSON.parse(after.text) : null;

let unchanged = null;
if (afterRows) {
  unchanged =
    JSON.stringify(beforeRows) === JSON.stringify(afterRows);
  console.log(
    `\nRollback verification: function definitions ${unchanged ? "UNCHANGED (rollback confirmed)" : "*** CHANGED — INVESTIGATE ***"}`,
  );
  console.log(`  before: ${beforeRows.length} rows, after: ${afterRows.length} rows`);
  if (!unchanged) {
    const beforeMap = new Map(beforeRows.map((r) => [r.proname, r.body_md5]));
    for (const r of afterRows) {
      if (beforeMap.get(r.proname) !== r.body_md5) {
        console.log(`  DIFFERS: ${r.proname}`);
      }
    }
  }
}

const dir = resolve(import.meta.dirname, "..", "evidence");
mkdirSync(dir, { recursive: true });
writeFileSync(
  resolve(dir, "dry-run-result.json"),
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      migration: "v1.8.7-fix-rotation-integrity.sql",
      mode: "dry-run (commit replaced by rollback)",
      verdict,
      httpStatus: result.status,
      response: result.text.slice(0, 4000),
      rollbackConfirmedUnchanged: unchanged,
      functionsBefore: beforeRows,
      functionsAfter: afterRows,
    },
    null,
    2,
  ),
);
console.log("\nWrote evidence/dry-run-result.json");
process.exitCode = verdict === "PASS" && unchanged !== false ? 0 : 1;
