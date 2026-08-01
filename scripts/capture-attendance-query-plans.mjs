/**
 * Query-plan capture for the Time & Attendance redesign range queries.
 *
 * Spec: .kiro/specs/time-attendance-ui-redesign
 * Requirement 20, criterion 13: the measured query plan for each new date-range
 * query is recorded before that query is released.
 *
 * Records `explain (analyze, buffers)` for the three access patterns that Today,
 * Review, and Coverage all depend on — a date window spanning every employee:
 *
 *   1. clock entries in a date window        (idx_time_clock_clock_in, v1.9.1)
 *   2. schedules in a date window            (idx_employee_schedules_date, v1.2.0)
 *   3. time-off overlapping a date window    (idx_pto_requests_range, v1.9.1, and
 *                                             idx_pto_requests_approved_range)
 *
 * WHAT THIS IS AND IS NOT
 *
 * This is a baseline, not a performance claim. On a table of tens or hundreds of
 * rows Postgres will usually choose a sequential scan over an index scan, and that
 * is the correct choice: reading one heap page beats descending a btree and then
 * visiting the heap anyway. The script records what the planner actually did. It
 * does not force an index and present the result as the real plan.
 *
 * It does optionally capture a second plan per query with `enable_seqscan` off.
 * That plan is a DIAGNOSTIC: its only purpose is to show that the index exists, is
 * valid, and can serve the predicate, so that when the tables grow the planner has
 * something to switch to. Every such plan is labelled `diagnostic` in the output
 * and its cost and timing must not be read as an improvement.
 *
 * READ-ONLY. Every statement is a SELECT or an EXPLAIN of a SELECT. `explain
 * (analyze)` does execute the statement it explains, which is why nothing here
 * explains anything but a SELECT. The `set local enable_seqscan = off` used for the
 * diagnostics is scoped to the transaction the query endpoint opens and cannot
 * outlive it.
 *
 * Usage:
 *
 *   node --env-file=.env.local scripts/capture-attendance-query-plans.mjs \
 *     --label stage-2-v1.9.1 --anchor 2026-07-31
 *
 * Flags:
 *   --label <name>     artifact name; resolves to
 *                      supabase/verification/query-plans/<name>.{json,txt}
 *                      (default: baseline)
 *   --anchor <date>    the date the windows are built around, YYYY-MM-DD
 *                      (default: the database's current_date). Pass an explicit
 *                      anchor to make a later capture comparable with this one.
 *   --no-diagnostics   skip the forced-index diagnostic plans
 *   --force            overwrite an existing artifact of the same label
 *   --print            also write the report to stdout
 *
 * Requires SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF, the same pair
 * scripts/run-sql.mjs uses. `explain` needs raw SQL, which the REST client the
 * row-retention script uses cannot issue, so this goes through the Management API.
 *
 * Exit codes: 0 when every plan was captured, 1 otherwise.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = [
  "Usage:",
  "  node --env-file=.env.local scripts/capture-attendance-query-plans.mjs [--label <name>] [--anchor <YYYY-MM-DD>] [--no-diagnostics] [--force] [--print]",
].join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// Arguments
// ─────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const flags = { diagnostics: true, force: false, print: false, help: false };
  let label = "baseline";
  let anchor = null;

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
      case "--no-diagnostics": flags.diagnostics = false; break;
      case "--force": flags.force = true; break;
      case "--print": flags.print = true; break;
      case "--help":
      case "-h": flags.help = true; break;
      case "--label": label = readValue(); break;
      case "--anchor": anchor = readValue(); break;
      default:
        throw new Error(`Unrecognised argument: ${arg}\n\n${USAGE}`);
    }
  }

  if (flags.help) return { ...flags, label, anchor };
  if (!label || label.startsWith("-")) throw new Error("--label needs a name.");
  if (!/^[A-Za-z0-9._-]+$/.test(label)) {
    throw new Error(`--label may only contain letters, digits, dot, underscore, and hyphen. Received: ${label}`);
  }
  if (anchor !== null && !/^\d{4}-\d{2}-\d{2}$/.test(anchor ?? "")) {
    throw new Error(`--anchor must be YYYY-MM-DD. Received: ${anchor}`);
  }

  return { ...flags, label, anchor };
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
const outDir = resolve(repoRoot, "supabase/verification/query-plans");
const jsonPath = resolve(outDir, `${args.label}.json`);
const textPath = resolve(outDir, `${args.label}.txt`);
const display = (path) => relative(repoRoot, path) || path;

const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const projectRef = process.env.SUPABASE_PROJECT_REF;

if (!accessToken || !projectRef) {
  console.error("Missing SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF.");
  console.error("Run with: node --env-file=.env.local scripts/capture-attendance-query-plans.mjs");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Management API
// ─────────────────────────────────────────────────────────────────────────────
async function query(sql) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ query: sql }),
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Query failed (${response.status}): ${detail}`);
  }
  return response.json();
}

/** Runs an explain and returns its plan as an array of lines, exactly as emitted. */
async function explain(sql, { forceIndex = false } = {}) {
  // `set local` is confined to the transaction the query endpoint opens for this
  // request, so it cannot affect anything else and needs no reset.
  const prefix = forceIndex ? "set local enable_seqscan = off;\n" : "";
  const rows = await query(`${prefix}explain (analyze, buffers)\n${sql}`);
  return rows.map((row) => row["QUERY PLAN"]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows
// ─────────────────────────────────────────────────────────────────────────────
function shiftDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Two windows per pattern, both spanning every employee:
 *   day   — one calendar date, what Team Today and the Live coverage panel ask for
 *   month — 31 dates centred on the anchor, the widest single request the Coverage
 *           Calendar and the Review range make
 */
function resolveWindows(anchor) {
  return {
    anchor,
    day: { from: anchor, to: anchor, label: "1 date" },
    month: { from: shiftDays(anchor, -15), to: shiftDays(anchor, 15), label: "31 dates" },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The queries under test
//
// Each is the set-based shape the attendance and coverage read paths issue: one
// request for a date window covering the whole roster, never one request per
// employee and never one per date (Requirement 20, criteria 1 to 4). The column
// lists are the ones the derivation needs, because a narrower list can change the
// plan an index-only scan is eligible for.
// ─────────────────────────────────────────────────────────────────────────────
const QUERIES = [
  {
    key: "clock-entries-day",
    title: "Clock entries on one date, all employees",
    table: "time_clock_entries",
    index: "idx_time_clock_clock_in",
    window: "day",
    consumers: "Team Today, Live coverage panel",
    // Half-open on a timestamptz, so the bound is sargable against the btree and
    // no row is counted twice at the boundary. The window is widened by a day on
    // each side of the work date because a clock instant maps to a work date in
    // the employee's own timezone, which can sit either side of the UTC date.
    sql: ({ from, to }) => `select id, profile_id, clock_in, clock_out, clock_status, break_minutes, total_hours, is_overtime
  from public.time_clock_entries
 where clock_in >= '${from}T00:00:00Z'::timestamptz - interval '1 day'
   and clock_in <  '${to}T00:00:00Z'::timestamptz + interval '2 days'
 order by clock_in`,
  },
  {
    key: "clock-entries-month",
    title: "Clock entries across a 31-date window, all employees",
    table: "time_clock_entries",
    index: "idx_time_clock_clock_in",
    window: "month",
    consumers: "Review range, metrics, trends",
    sql: ({ from, to }) => `select id, profile_id, clock_in, clock_out, clock_status, break_minutes, total_hours, is_overtime
  from public.time_clock_entries
 where clock_in >= '${from}T00:00:00Z'::timestamptz - interval '1 day'
   and clock_in <  '${to}T00:00:00Z'::timestamptz + interval '2 days'
 order by clock_in`,
  },
  {
    key: "schedules-day",
    title: "Schedules on one date, all employees",
    table: "employee_schedules",
    index: "idx_employee_schedules_date",
    window: "day",
    consumers: "Team Today, Live coverage panel",
    sql: ({ from, to }) => `select id, profile_id, schedule_date, shift_start, shift_end, shift_type, status
  from public.employee_schedules
 where schedule_date >= '${from}'::date
   and schedule_date <= '${to}'::date
 order by schedule_date, profile_id`,
  },
  {
    key: "schedules-month",
    title: "Schedules across a 31-date window, all employees",
    table: "employee_schedules",
    index: "idx_employee_schedules_date",
    window: "month",
    consumers: "Coverage Calendar, Health Ribbon, Schedule screen",
    sql: ({ from, to }) => `select id, profile_id, schedule_date, shift_start, shift_end, shift_type, status
  from public.employee_schedules
 where schedule_date >= '${from}'::date
   and schedule_date <= '${to}'::date
 order by schedule_date, profile_id`,
  },
  {
    key: "pto-overlap-month",
    title: "Time-off overlapping a 31-date window, all employees, every status",
    table: "pto_requests",
    index: "idx_pto_requests_range",
    window: "month",
    consumers: "Time-off list, Review",
    // Standard interval overlap: a request touches the window when it starts on or
    // before the window ends and ends on or after the window starts.
    sql: ({ from, to }) => `select id, profile_id, pto_type, start_date, end_date, total_days, status
  from public.pto_requests
 where start_date <= '${to}'::date
   and end_date   >= '${from}'::date
 order by start_date, profile_id`,
  },
  {
    key: "pto-overlap-approved-month",
    title: "Approved time-off overlapping a 31-date window, all employees",
    table: "pto_requests",
    index: "idx_pto_requests_approved_range",
    window: "month",
    consumers: "Coverage Calendar, Health Ribbon, Approval Impact Preview",
    // status = 'approved' implies the partial index predicate, so the partial index
    // is eligible. 'partially_approved' becomes a legal status in stage 4 (v1.9.3);
    // until then that branch matches no row.
    sql: ({ from, to }) => `select id, profile_id, pto_type, start_date, end_date, total_days, status
  from public.pto_requests
 where start_date <= '${to}'::date
   and end_date   >= '${from}'::date
   and status in ('approved', 'partially_approved')
 order by start_date, profile_id`,
  },
];

// One forced-index diagnostic per distinct index is enough to show the index is
// usable; running it for every window would repeat the same evidence.
const DIAGNOSTIC_KEYS = new Set([
  "clock-entries-month",
  "schedules-month",
  "pto-overlap-month",
  "pto-overlap-approved-month",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Plan reading
// ─────────────────────────────────────────────────────────────────────────────
const SCAN_NODES = [
  "Seq Scan",
  "Index Only Scan",
  "Index Scan",
  "Bitmap Heap Scan",
  "Bitmap Index Scan",
];

function readPlan(lines, expectedIndex) {
  const text = lines.join("\n");
  const scans = SCAN_NODES.filter((node) => new RegExp(`(^|\\s|>)${node} `).test(text));
  const metric = (name) => {
    const match = text.match(new RegExp(`${name}: ([0-9.]+) ms`));
    return match ? Number(match[1]) : null;
  };
  return {
    scanNodes: scans,
    usesExpectedIndex: expectedIndex ? text.includes(expectedIndex) : false,
    planningTimeMs: metric("Planning Time"),
    executionTimeMs: metric("Execution Time"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment probe
// ─────────────────────────────────────────────────────────────────────────────
const PROBE_SQL = `select
  current_setting('server_version')                                        as server_version,
  current_date::text                                                       as db_current_date,
  now()::text                                                              as db_now,
  (select count(*) from public.time_clock_entries)                         as time_clock_entries,
  (select count(*) from public.time_clock_breaks)                          as time_clock_breaks,
  (select count(*) from public.employee_schedules)                         as employee_schedules,
  (select count(*) from public.pto_requests)                              as pto_requests,
  (select count(*) from public.pto_requests where status = 'approved')     as pto_requests_approved,
  (select count(*) from public.profiles where is_active)                   as active_profiles,
  (select min(clock_in)::text from public.time_clock_entries)              as clock_in_min,
  (select max(clock_in)::text from public.time_clock_entries)              as clock_in_max,
  (select min(schedule_date)::text from public.employee_schedules)         as schedule_date_min,
  (select max(schedule_date)::text from public.employee_schedules)         as schedule_date_max,
  (select min(start_date)::text from public.pto_requests)                  as pto_start_date_min,
  (select max(end_date)::text from public.pto_requests)                    as pto_end_date_max`;

// Index inventory. last_analyze matters: the planner chooses from statistics, so a
// table that has never been analysed can produce a plan that says little.
const INDEX_SQL = `select i.indexname                                          as index_name,
       i.tablename                                           as table_name,
       i.indexdef                                            as definition,
       pg_relation_size(('public.' || quote_ident(i.indexname))::regclass) as size_bytes,
       idx.indisvalid                                        as is_valid,
       idx.indisunique                                        as is_unique,
       idx.indpred is not null                                as is_partial,
       coalesce(s.idx_scan, 0)                                as scans_since_stats_reset,
       (select greatest(coalesce(t.last_analyze, '-infinity'::timestamptz),
                        coalesce(t.last_autoanalyze, '-infinity'::timestamptz))::text
          from pg_stat_user_tables t
         where t.relname = i.tablename and t.schemaname = 'public')  as table_last_analyze
  from pg_indexes i
  join pg_class c on c.relname = i.indexname
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = i.schemaname
  join pg_index idx on idx.indexrelid = c.oid
  left join pg_stat_user_indexes s on s.indexrelid = c.oid
 where i.schemaname = 'public'
   and i.tablename in ('time_clock_entries', 'time_clock_breaks', 'employee_schedules', 'pto_requests')
 order by i.tablename, i.indexname`;

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────
const rule = (char = "-") => char.repeat(78);

function buildReport(snapshot) {
  const out = [];
  const push = (...lines) => out.push(...lines);

  push(
    rule("="),
    `Time & Attendance range-query plans — ${snapshot.label}`,
    rule("="),
    "",
    `Captured        ${snapshot.capturedAt}`,
    `Project         ${snapshot.project.ref}`,
    `Postgres        ${snapshot.environment.server_version}`,
    `Database date   ${snapshot.environment.db_current_date}`,
    `Window anchor   ${snapshot.windows.anchor}`,
    `Migration       supabase/migrations/v1.9.1-attendance-indexes.sql`,
    `Requirement     20.13 — record the measured plan for each new range query`,
    "",
    "This is a BASELINE, not a performance result. See the interpretation note in",
    "supabase/verification/v1.9.1-attendance-range-query-plans.md.",
    "",
    rule(),
    "ROW COUNTS AT CAPTURE",
    rule(),
  );

  for (const [table, count] of Object.entries(snapshot.rowCounts)) {
    push(`  ${table.padEnd(24)} ${String(count).padStart(8)}`);
  }
  push(
    "",
    "  Data extent",
    `    clock_in         ${snapshot.environment.clock_in_min ?? "none"} .. ${snapshot.environment.clock_in_max ?? "none"}`,
    `    schedule_date    ${snapshot.environment.schedule_date_min ?? "none"} .. ${snapshot.environment.schedule_date_max ?? "none"}`,
    `    pto range        ${snapshot.environment.pto_start_date_min ?? "none"} .. ${snapshot.environment.pto_end_date_max ?? "none"}`,
    "",
    rule(),
    "INDEX INVENTORY",
    rule(),
  );

  for (const index of snapshot.indexes) {
    const tags = [
      index.is_valid ? "valid" : "INVALID",
      index.is_unique ? "unique" : null,
      index.is_partial ? "partial" : null,
    ].filter(Boolean).join(", ");
    push(
      `  ${index.index_name}`,
      `    ${index.definition}`,
      `    ${tags}; ${index.size_bytes} bytes; ${index.scans_since_stats_reset} scan(s) since stats reset`,
    );
  }

  push(
    "",
    `  Last analyze per table (the planner reads statistics, not row counts):`,
  );
  for (const [table, when] of Object.entries(snapshot.lastAnalyze)) {
    push(`    ${table.padEnd(24)} ${when === "-infinity" ? "never analysed" : when}`);
  }

  push("", rule(), "WINDOWS", rule());
  for (const [name, window] of Object.entries(snapshot.windows)) {
    if (name === "anchor") continue;
    push(`  ${name.padEnd(8)} ${window.from} .. ${window.to}  (${window.label})`);
  }

  for (const plan of snapshot.plans) {
    push(
      "",
      rule("="),
      `${plan.key} — ${plan.title}`,
      rule("="),
      `Table       ${plan.table}`,
      `Index for   ${plan.index}`,
      `Window      ${plan.windowFrom} .. ${plan.windowTo}`,
      `Consumers   ${plan.consumers}`,
      "",
      "SQL",
      ...plan.sql.split("\n").map((line) => `  ${line}`),
      "",
      "MEASURED PLAN — explain (analyze, buffers), planner left to choose",
      ...plan.measured.plan.map((line) => `  ${line}`),
      "",
      `  scan nodes chosen: ${plan.measured.scanNodes.join(", ") || "none reported"}`,
      `  used ${plan.index}: ${plan.measured.usesExpectedIndex ? "yes" : "no"}`,
    );

    if (plan.diagnostic) {
      push(
        "",
        "DIAGNOSTIC PLAN — enable_seqscan = off. NOT the plan that runs in production.",
        "Recorded only to show the index is valid and can serve this predicate.",
        ...plan.diagnostic.plan.map((line) => `  ${line}`),
        "",
        `  scan nodes chosen: ${plan.diagnostic.scanNodes.join(", ") || "none reported"}`,
        `  used ${plan.index}: ${plan.diagnostic.usesExpectedIndex ? "yes" : "no"}`,
      );
    }
  }

  push("", rule("="), "SUMMARY", rule("="));
  for (const plan of snapshot.plans) {
    const chosen = plan.measured.usesExpectedIndex ? plan.index : plan.measured.scanNodes[0] ?? "unknown";
    const usable = plan.diagnostic ? (plan.diagnostic.usesExpectedIndex ? "yes" : "NO") : "not tested";
    push(`  ${plan.key.padEnd(28)} chose ${chosen.padEnd(34)} index usable when forced: ${usable}`);
  }
  push("");

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
let existing = null;
try {
  existing = JSON.parse(await readFile(jsonPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") {
    console.error(`Existing artifact at ${display(jsonPath)} is unreadable or not valid JSON.`);
    throw error;
  }
}

if (existing && !args.force) {
  console.error(`Artifact ${display(jsonPath)} already exists (captured ${existing.capturedAt}).`);
  console.error("Pass --force to replace it, or use a new --label so both captures are kept.");
  process.exit(1);
}

console.log(`Project: ${projectRef}`);

const [environment] = await query(PROBE_SQL);
const indexRows = await query(INDEX_SQL);

const anchor = args.anchor ?? environment.db_current_date;
const windows = resolveWindows(anchor);
console.log(`Anchor:  ${anchor}${args.anchor ? "" : " (database current_date)"}`);
console.log("");

const plans = [];
for (const spec of QUERIES) {
  const window = windows[spec.window];
  const sql = spec.sql(window);

  process.stdout.write(`  ${spec.key.padEnd(28)} `);
  const measuredLines = await explain(sql);
  const measured = { plan: measuredLines, ...readPlan(measuredLines, spec.index) };

  let diagnostic = null;
  if (args.diagnostics && DIAGNOSTIC_KEYS.has(spec.key)) {
    const diagnosticLines = await explain(sql, { forceIndex: true });
    diagnostic = { plan: diagnosticLines, ...readPlan(diagnosticLines, spec.index) };
  }

  console.log(
    `chose ${measured.usesExpectedIndex ? spec.index : measured.scanNodes[0] ?? "unknown"}` +
    (diagnostic ? `; index usable when forced: ${diagnostic.usesExpectedIndex ? "yes" : "NO"}` : ""),
  );

  plans.push({
    key: spec.key,
    title: spec.title,
    table: spec.table,
    index: spec.index,
    consumers: spec.consumers,
    window: spec.window,
    windowFrom: window.from,
    windowTo: window.to,
    sql,
    measured,
    diagnostic,
  });
}

const snapshot = {
  label: args.label,
  capturedAt: new Date().toISOString(),
  requirement: "20.13",
  spec: ".kiro/specs/time-attendance-ui-redesign",
  migration: "supabase/migrations/v1.9.1-attendance-indexes.sql",
  project: { ref: projectRef },
  environment,
  windows,
  rowCounts: {
    time_clock_entries: environment.time_clock_entries,
    time_clock_breaks: environment.time_clock_breaks,
    employee_schedules: environment.employee_schedules,
    pto_requests: environment.pto_requests,
    pto_requests_approved: environment.pto_requests_approved,
    active_profiles: environment.active_profiles,
  },
  lastAnalyze: Object.fromEntries(
    [...new Set(indexRows.map((row) => row.table_name))].map((table) => [
      table,
      indexRows.find((row) => row.table_name === table)?.table_last_analyze ?? "unknown",
    ]),
  ),
  // table_last_analyze is per-table, already summarised above; drop it from the
  // per-index rows so it is recorded once rather than repeated on every index.
  indexes: indexRows.map((row) => {
    const index = { ...row };
    delete index.table_last_analyze;
    return index;
  }),
  plans,
};

const report = buildReport(snapshot);

await mkdir(outDir, { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
await writeFile(textPath, report, "utf8");

if (args.print) {
  console.log("");
  console.log(report);
}

console.log("");
console.log(`${existing ? "Replaced" : "Wrote"} ${display(jsonPath)}`);
console.log(`${existing ? "Replaced" : "Wrote"} ${display(textPath)}`);

const missingIndex = plans.filter((plan) => plan.diagnostic && !plan.diagnostic.usesExpectedIndex);
if (missingIndex.length > 0) {
  console.error("");
  console.error("At least one index could not serve its query even with enable_seqscan off:");
  for (const plan of missingIndex) {
    console.error(`  ${plan.key} did not reach ${plan.index}`);
  }
  console.error("The index shape and the query predicate disagree. Investigate before release.");
  process.exit(1);
}

const invalid = snapshot.indexes.filter((index) => !index.is_valid);
if (invalid.length > 0) {
  console.error("");
  console.error(`Invalid index/indexes present: ${invalid.map((index) => index.index_name).join(", ")}`);
  process.exit(1);
}

process.exit(0);
