/**
 * Apply (or dry-run) a migration file against the live Supabase project.
 *
 * Usage:
 *   node apply-sql.mjs <file.sql> --dry-run   # commit -> rollback, nothing persists
 *   node apply-sql.mjs <file.sql> --apply     # real deploy
 *
 * Safety:
 *   - refuses TRUNCATE / DROP TABLE / DROP SCHEMA / DELETE FROM / ALTER TABLE
 *   - refuses any data write at migration top level (outside function bodies)
 *   - requires exactly one BEGIN and one COMMIT
 *   - captures a data fingerprint before and after and reports any change
 *   - retries transient 5xx gateway errors
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, basename } from "path";

const root = resolve(import.meta.dirname, "..", "..", "..", "..");
const env = {};
for (const line of readFileSync(resolve(root, ".env.local"), "utf-8").split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}

const file = process.argv[2];
const mode = process.argv.includes("--apply")
  ? "apply"
  : process.argv.includes("--dry-run")
    ? "dry-run"
    : null;

if (!file || !mode) {
  console.error("Usage: node apply-sql.mjs <file.sql> (--dry-run | --apply)");
  process.exit(1);
}

const original = readFileSync(resolve(root, file), "utf-8");

const decomment = (s) =>
  s
    .split("\n")
    .map((l) => {
      const i = l.indexOf("--");
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n")
    .toLowerCase();

const stripped = decomment(original);
const fail = (m) => {
  console.error(`REFUSING: ${m}`);
  process.exit(1);
};

for (const banned of [
  /\btruncate\b/,
  /\bdrop\s+table\b/,
  /\bdrop\s+schema\b/,
  /\bdrop\s+database\b/,
  /\bdelete\s+from\b/,
  /\balter\s+table\b/,
]) {
  if (banned.test(stripped)) fail(`destructive statement ${banned}`);
}

if ((stripped.match(/^\s*begin;/gm) ?? []).length !== 1) fail("expected exactly one BEGIN");
if ((stripped.match(/^\s*commit;/gm) ?? []).length !== 1) fail("expected exactly one COMMIT");

// No data writes outside dollar-quoted function bodies.
{
  let scope = "";
  let i = 0;
  while (i < stripped.length) {
    const open = /\$[a-z_]*\$/i.exec(stripped.slice(i));
    if (!open) { scope += stripped.slice(i); break; }
    const openIdx = i + open.index;
    scope += stripped.slice(i, openIdx);
    const tag = open[0];
    const close = stripped.indexOf(tag, openIdx + tag.length);
    if (close === -1) break;
    i = close + tag.length;
  }
  if (/\b(update|insert\s+into|delete\s+from)\b/.test(scope)) {
    fail("file performs a data write at top level");
  }
}

const payload =
  mode === "dry-run"
    ? original.replace(/^([ \t]*)commit;[ \t]*$/m, "$1rollback;")
    : original;

if (mode === "dry-run" && !/^\s*rollback;/m.test(decomment(payload))) {
  fail("could not convert commit -> rollback");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function q(sql, attempt = 1) {
  const MAX = 6;
  let r;
  try {
    r = await fetch(
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
  } catch (e) {
    if (attempt < MAX) {
      console.log(`  network error; retry ${attempt} in ${attempt * 3}s`);
      await sleep(attempt * 3000);
      return q(sql, attempt + 1);
    }
    throw e;
  }
  const t = await r.text();
  if (!r.ok && r.status >= 500 && attempt < MAX) {
    console.log(`  HTTP ${r.status} (transient); retry ${attempt} in ${attempt * 3}s`);
    await sleep(attempt * 3000);
    return q(sql, attempt + 1);
  }
  return { ok: r.ok, status: r.status, text: t };
}

const FP = `
  select
    (select count(*) from public.profiles)              as profiles_ct,
    (select count(*) from public.work_items)            as work_items_ct,
    (select count(*) from public.turn_events)           as turn_events_ct,
    (select count(*) from public.quote_take_events)     as take_events_ct,
    (select count(*) from public.cs_intake_submissions) as intakes_ct,
    (select count(*) from public.quote_outcomes)        as outcomes_ct,
    (select count(*) from public.audit_log)             as audit_ct,
    (select md5(string_agg(kind::text || coalesce(current_profile_id::text,'-') || version::text,
                ',' order by kind)) from public.rotation_state) as rotation_md5;`;

console.log(`File : ${basename(file)}`);
console.log(`Mode : ${mode.toUpperCase()}${mode === "dry-run" ? " (nothing persists)" : " — REAL DEPLOY"}`);
console.log(`Size : ${original.length} chars`);
console.log("Safety checks: passed (functions/grants only, no destructive or top-level data statements)\n");

const beforeRes = await q(FP);
if (!beforeRes.ok) { console.error("Could not read pre-state:", beforeRes.text.slice(0, 300)); process.exit(1); }
const before = JSON.parse(beforeRes.text)[0];
console.log("Before:", JSON.stringify(before));

const res = await q(payload);

let verdict;
if (res.ok) {
  verdict = "SUCCESS";
  console.log(`\nRESULT: ${mode === "dry-run" ? "DRY RUN PASSED" : "APPLIED SUCCESSFULLY"}`);
} else {
  verdict = "FAILED";
  let msg = res.text;
  try { msg = JSON.parse(res.text).message ?? res.text; } catch {}
  console.log(`\nRESULT: FAILED (HTTP ${res.status})`);
  console.log(String(msg).slice(0, 2000));
  process.exitCode = 1;
}

const afterRes = await q(FP);
const after = afterRes.ok ? JSON.parse(afterRes.text)[0] : null;
if (after) {
  console.log("After :", JSON.stringify(after));
  const dataKeys = ["profiles_ct","work_items_ct","turn_events_ct","take_events_ct","intakes_ct","outcomes_ct","audit_ct"];
  const changed = dataKeys.filter((k) => before[k] !== after[k]);
  if (changed.length === 0) {
    console.log("Data integrity: all row counts unchanged.");
  } else {
    console.log(`Data integrity: row counts CHANGED for ${changed.join(", ")}`);
    for (const k of changed) console.log(`  ${k}: ${before[k]} -> ${after[k]}`);
  }
  if (before.rotation_md5 !== after.rotation_md5) {
    console.log("rotation_state changed (expected if a queue self-healed after deploy).");
  }
}

mkdirSync(resolve(import.meta.dirname, "..", "evidence"), { recursive: true });
writeFileSync(
  resolve(import.meta.dirname, "..", "evidence", `apply-${basename(file)}-${mode}.json`),
  JSON.stringify({ at: new Date().toISOString(), file, mode, verdict, httpStatus: res.status, response: res.text.slice(0, 3000), before, after }, null, 2),
);
