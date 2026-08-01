/**
 * Row-retention verification for the Time & Attendance redesign migrations.
 *
 * Spec: .kiro/specs/time-attendance-ui-redesign
 * Requirement 23, criterion 3: every existing row in time_clock_entries,
 * time_clock_breaks, employee_schedules, pto_requests, pto_balances,
 * payroll_periods, payroll_summaries, and audit_log is retained across every
 * migration stage.
 *
 * This script is read-only. It issues one exact head count per preserved table
 * and never inserts, updates, or deletes anything.
 *
 * Usage (same env handling as scripts/bootstrap-users.mjs):
 *
 *   node --env-file=.env.local scripts/verify-attendance-row-retention.mjs --snapshot --label stage-2-pre
 *   ... apply supabase/migrations/v1.9.1-attendance-indexes.sql ...
 *   node --env-file=.env.local scripts/verify-attendance-row-retention.mjs --verify --label stage-2-pre
 *
 * Flags:
 *   --snapshot        capture current counts and write them to the snapshot file
 *   --verify          re-count and compare against the snapshot file
 *   --label <name>    snapshot name; resolves to
 *                     supabase/verification/row-retention/<name>.json (default: baseline)
 *   --file <path>     explicit snapshot path, overriding --label
 *   --strict          under --verify, also fail when a table gained rows
 *                     (use for a stage whose migration must touch no preserved row)
 *   --force           allow --snapshot to overwrite an existing snapshot file
 *
 * Exit codes: 0 when every preserved table retained its rows, 1 otherwise.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const PRESERVED_TABLES = [
  "time_clock_entries",
  "time_clock_breaks",
  "employee_schedules",
  "pto_requests",
  "pto_balances",
  "payroll_periods",
  "payroll_summaries",
  "audit_log",
];

const USAGE = [
  "Usage:",
  "  node --env-file=.env.local scripts/verify-attendance-row-retention.mjs --snapshot [--label <name>] [--file <path>] [--force]",
  "  node --env-file=.env.local scripts/verify-attendance-row-retention.mjs --verify   [--label <name>] [--file <path>] [--strict]",
].join("\n");

function parseArgs(argv) {
  const flags = { snapshot: false, verify: false, strict: false, force: false, help: false };
  let label = "baseline";
  let file = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [name, inlineValue] = arg.startsWith("--") && arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, null];
    const readValue = () => {
      if (inlineValue !== null) return inlineValue;
      i += 1;
      return argv[i];
    };

    switch (name) {
      case "--snapshot": flags.snapshot = true; break;
      case "--verify": flags.verify = true; break;
      case "--strict": flags.strict = true; break;
      case "--force": flags.force = true; break;
      case "--help":
      case "-h": flags.help = true; break;
      case "--label": label = readValue(); break;
      case "--file": file = readValue(); break;
      default:
        throw new Error(`Unrecognised argument: ${arg}\n\n${USAGE}`);
    }
  }

  if (flags.help) return { ...flags, label, file };
  if (flags.snapshot === flags.verify) {
    throw new Error(`Choose exactly one of --snapshot or --verify.\n\n${USAGE}`);
  }
  if (!label || label.startsWith("-")) throw new Error("--label needs a name.");
  if (!/^[A-Za-z0-9._-]+$/.test(label)) {
    throw new Error(`--label may only contain letters, digits, dot, underscore, and hyphen. Received: ${label}`);
  }
  if (file !== null && (!file || file.startsWith("-"))) throw new Error("--file needs a path.");

  return { ...flags, label, file };
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const snapshotPath = args.file
  ? resolve(args.file)
  : resolve(repoRoot, "supabase/verification/row-retention", `${args.label}.json`);
const displayPath = relative(repoRoot, snapshotPath) || snapshotPath;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !secret) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(1);
}

// Identifies which project produced a snapshot without disclosing any credential.
const projectHost = new URL(url).host;

const supabase = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Exact row count for one table. `head: true` returns no rows, so this stays a
 * count-only read regardless of table size.
 */
async function countRows(table) {
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
  if (error) return { table, count: null, error: error.message };
  return { table, count: count ?? 0, error: null };
}

const results = await Promise.all(PRESERVED_TABLES.map(countRows));
const failedReads = results.filter((result) => result.error);
const nameWidth = Math.max(...PRESERVED_TABLES.map((table) => table.length));

if (failedReads.length > 0) {
  console.error(`Could not count ${failedReads.length} of ${PRESERVED_TABLES.length} preserved tables:`);
  for (const result of failedReads) {
    console.error(`  ${result.table.padEnd(nameWidth)}  ${result.error}`);
  }
  process.exit(1);
}

const counts = Object.fromEntries(results.map((result) => [result.table, result.count]));
const total = results.reduce((sum, result) => sum + result.count, 0);
const capturedAt = new Date().toISOString();

console.log(`Project: ${projectHost}`);
console.log("");

if (args.snapshot) {
  let existing = null;
  try {
    existing = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Existing snapshot at ${displayPath} is unreadable or not valid JSON.`);
      throw error;
    }
  }

  if (existing && !args.force) {
    console.error(`Snapshot ${displayPath} already exists (captured ${existing.capturedAt}).`);
    console.error("Overwriting it would discard the pre-migration baseline. Pass --force to replace it, or use a new --label.");
    process.exit(1);
  }

  console.log(`Row retention snapshot "${args.label}"`);
  for (const result of results) {
    console.log(`  ${result.table.padEnd(nameWidth)}  ${String(result.count).padStart(7)}`);
  }
  console.log(`  ${"".padEnd(nameWidth)}  ${"-".repeat(7)}`);
  console.log(`  ${"total".padEnd(nameWidth)}  ${String(total).padStart(7)}`);
  console.log("");

  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(
    snapshotPath,
    `${JSON.stringify({ label: args.label, capturedAt, project: projectHost, tables: counts }, null, 2)}\n`,
    "utf8",
  );
  console.log(`${existing ? "Replaced" : "Wrote"} ${displayPath}`);
  console.log(`Verify after the migration with: --verify --label ${args.label}`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(await readFile(snapshotPath, "utf8"));
} catch (error) {
  if (error.code === "ENOENT") {
    console.error(`No baseline at ${displayPath}.`);
    console.error(`Capture one before the migration with: --snapshot --label ${args.label}`);
    process.exit(1);
  }
  console.error(`Baseline at ${displayPath} is unreadable or not valid JSON.`);
  throw error;
}

if (!baseline.tables || typeof baseline.tables !== "object") {
  console.error(`Baseline at ${displayPath} has no table counts. Recapture it with --snapshot.`);
  process.exit(1);
}

if (baseline.project && baseline.project !== projectHost) {
  console.error(`Baseline was captured against ${baseline.project} but this run targets ${projectHost}.`);
  process.exit(1);
}

console.log(`Row retention verification against "${baseline.label ?? args.label}" captured ${baseline.capturedAt ?? "at an unrecorded time"}`);
console.log(`  ${"table".padEnd(nameWidth)}  baseline  current    delta`);

const lost = [];
const gained = [];
const missingFromBaseline = [];

for (const result of results) {
  const before = baseline.tables[result.table];
  if (typeof before !== "number") {
    missingFromBaseline.push(result.table);
    console.log(`  ${result.table.padEnd(nameWidth)}  ${"absent".padStart(8)}  ${String(result.count).padStart(7)}  ${"n/a".padStart(7)}`);
    continue;
  }

  const delta = result.count - before;
  if (delta < 0) lost.push({ table: result.table, before, after: result.count, delta });
  if (delta > 0) gained.push({ table: result.table, before, after: result.count, delta });
  const deltaText = delta > 0 ? `+${delta}` : String(delta);
  console.log(`  ${result.table.padEnd(nameWidth)}  ${String(before).padStart(8)}  ${String(result.count).padStart(7)}  ${deltaText.padStart(7)}`);
}

console.log("");

if (missingFromBaseline.length > 0) {
  console.error(`Baseline carries no count for: ${missingFromBaseline.join(", ")}. Recapture it with --snapshot.`);
  process.exit(1);
}

if (lost.length > 0) {
  console.error("ROW RETENTION FAILED (Requirement 23, criterion 3).");
  for (const entry of lost) {
    console.error(`  ${entry.table} lost ${Math.abs(entry.delta)} row(s): ${entry.before} -> ${entry.after}`);
  }
  console.error("");
  console.error("Roll the migration back using the rollback path in its header comment before going further.");
  process.exit(1);
}

if (gained.length > 0) {
  const summary = gained.map((entry) => `${entry.table} +${entry.delta}`).join(", ");
  if (args.strict) {
    console.error("ROW RETENTION FAILED under --strict: this stage was expected to touch no preserved row.");
    console.error(`  ${summary}`);
    process.exit(1);
  }
  console.log(`Rows gained since the baseline: ${summary}`);
  console.log("No row was lost, so retention holds. Confirm the gains are ordinary application activity and not migration writes.");
}

console.log(`RETAINED: all ${PRESERVED_TABLES.length} preserved tables kept every baseline row.`);
process.exit(0);
