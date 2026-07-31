/**
 * SCENARIO DRY RUN — real PostgreSQL verification of the fixed rotation engine.
 *
 * Approach (chosen for safety):
 *   public.profiles.id has a FOREIGN KEY to auth.users, so synthetic agents
 *   cannot be inserted without creating auth users — which we will not do. And
 *   mutating real agents, even inside a rolled-back transaction, is avoidable.
 *
 *   Instead, inside one transaction that ends in ROLLBACK:
 *     1. install v1.8.7 (functions only)
 *     2. create a TEMPORARY table `probe_profiles` with the columns the selector
 *        reads (no FK, no unique indexes)
 *     3. read back the ACTUAL installed body of next_eligible_profile via
 *        pg_get_functiondef, rewrite only the table reference and the function
 *        name, and install it as `dryrun_nep` — so the logic under test is
 *        byte-identical to what will run in production
 *     4. drive `dryrun_nep` through every required scenario with controlled data
 *     5. ROLLBACK
 *
 *   NO row in public.profiles, public.rotation_state, public.turn_events,
 *   public.work_items or any intake table is read-modified-written at any point.
 *   The only writes are to a TEMPORARY table.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
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

const migration = readFileSync(
  resolve(root, "supabase/migrations/v1.8.7-fix-rotation-integrity.sql"),
  "utf-8",
);
const body = migration
  .replace(/^([ \t]*)begin;[ \t]*$/m, "")
  .replace(/^([ \t]*)commit;[ \t]*$/m, "");

const A = (n) => `'aaaaaaaa-0000-4000-8000-00000000000${n}'::uuid`;

const scenarios = `
-- ═══════════════════════════════════════════════════════════════════════════
-- Isolated fixture: a TEMPORARY mirror of the columns the selector reads.
-- No foreign keys, no unique indexes, dropped automatically on rollback.
-- ═══════════════════════════════════════════════════════════════════════════
create temporary table probe_profiles (
  id                   uuid primary key,
  display_name         text,
  role                 public.app_role,
  is_active            boolean,
  availability         public.availability_status,
  whatsapp_active      boolean,
  ringcentral_active   boolean,
  workload_active      boolean,
  whatsapp_position    integer,
  ringcentral_position integer,
  workload_position    integer
);

create temporary table dryrun_results (
  scenario text, expected text, actual text, passed boolean
);

-- ═══════════════════════════════════════════════════════════════════════════
-- Mirror the ACTUAL installed next_eligible_profile onto probe_profiles.
-- Only the table reference and the function name change, so the ORDER BY /
-- WHERE / LIMIT semantics under test are exactly what production will run.
-- ═══════════════════════════════════════════════════════════════════════════
do $mirror$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'next_eligible_profile';

  if v_def is null then
    raise exception 'next_eligible_profile not found after installing v1.8.7';
  end if;

  -- Sanity: the body must reference public.profiles exactly once.
  if (length(v_def) - length(replace(v_def, 'public.profiles', ''))) / length('public.profiles') <> 1 then
    raise exception 'unexpected number of public.profiles references in selector body';
  end if;

  v_def := replace(v_def, 'public.profiles', 'probe_profiles');
  v_def := replace(v_def, 'FUNCTION public.next_eligible_profile', 'FUNCTION public.dryrun_nep');
  -- A SECURITY DEFINER function with a pinned search_path cannot see temp tables.
  v_def := replace(v_def, 'SECURITY DEFINER', '');
  v_def := regexp_replace(v_def, 'SET search_path TO [^\\n]*', '', 'g');

  execute v_def;
end
$mirror$;

-- ═══════════════════════════════════════════════════════════════════════════
-- S1: three eligible agents, with a genuine gap between positions 2 and 10.
-- ═══════════════════════════════════════════════════════════════════════════
insert into probe_profiles values
  (${A(1)}, 'A1', 'agent', true, 'available', true, true, true,  1,  1,  1),
  (${A(2)}, 'A2', 'agent', true, 'available', true, true, true,  2,  2,  2),
  (${A(3)}, 'A3', 'agent', true, 'available', true, true, true, 10, 10, 10);

insert into dryrun_results select 'S1_fixture_three_eligible', '3',
  (select count(*)::text from probe_profiles where is_active and availability='available'),
  (select count(*) from probe_profiles where is_active and availability='available') = 3;

insert into dryrun_results select 'S1_from_1_gives_A2', 'A2',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', 1)), 'NULL'),
  public.dryrun_nep('whatsapp', 1) = ${A(2)};

insert into dryrun_results select 'S1_from_2_gives_A3', 'A3',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', 2)), 'NULL'),
  public.dryrun_nep('whatsapp', 2) = ${A(3)};

insert into dryrun_results select 'S1_gap_from_5_gives_A3', 'A3',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', 5)), 'NULL'),
  public.dryrun_nep('whatsapp', 5) = ${A(3)};

-- THE PRIMARY FIX: highest position must wrap back to the lowest.
insert into dryrun_results select 'S1_WRAPAROUND_from_10_gives_A1', 'A1',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', 10)), 'NULL'),
  public.dryrun_nep('whatsapp', 10) = ${A(1)};

insert into dryrun_results select 'S1_beyond_highest_wraps', 'A1',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', 999)), 'NULL'),
  public.dryrun_nep('whatsapp', 999) = ${A(1)};

insert into dryrun_results select 'S1_null_after_gives_lowest', 'A1',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', null)), 'NULL'),
  public.dryrun_nep('whatsapp', null) = ${A(1)};

insert into dryrun_results select 'S1_never_null_pos_0_to_20', '0 null results',
  format('%s null results', count(*) filter (where public.dryrun_nep('whatsapp', g.p) is null)),
  count(*) filter (where public.dryrun_nep('whatsapp', g.p) is null) = 0
from generate_series(0, 20) g(p);

-- Full cycle: 1 -> 2 -> 10 -> 1 (wrap) proves a closed loop.
insert into dryrun_results select 'S1_full_cycle_closes', 'A1',
  coalesce((select display_name from probe_profiles where id =
    public.dryrun_nep('whatsapp',
      (select whatsapp_position from probe_profiles where id =
        public.dryrun_nep('whatsapp',
          (select whatsapp_position from probe_profiles where id =
            public.dryrun_nep('whatsapp', 1)))))), 'NULL'),
  public.dryrun_nep('whatsapp',
    (select whatsapp_position from probe_profiles where id =
      public.dryrun_nep('whatsapp',
        (select whatsapp_position from probe_profiles where id =
          public.dryrun_nep('whatsapp', 1))))) = ${A(1)};

-- ═══════════════════════════════════════════════════════════════════════════
-- S2: two eligible agents.
-- ═══════════════════════════════════════════════════════════════════════════
update probe_profiles set availability = 'break' where id = ${A(3)};

insert into dryrun_results select 'S2_two_agents_wrap_from_2', 'A1',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', 2)), 'NULL'),
  public.dryrun_nep('whatsapp', 2) = ${A(1)};

insert into dryrun_results select 'S2_two_agents_from_1', 'A2',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', 1)), 'NULL'),
  public.dryrun_nep('whatsapp', 1) = ${A(2)};

-- ═══════════════════════════════════════════════════════════════════════════
-- S3: ONE eligible agent must self-loop, never NULL (invariant 10).
-- ═══════════════════════════════════════════════════════════════════════════
update probe_profiles set availability = 'break' where id = ${A(2)};

insert into dryrun_results select 'S3_one_agent_self_loop', 'A1',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', 1)), 'NULL'),
  public.dryrun_nep('whatsapp', 1) = ${A(1)};

insert into dryrun_results select 'S3_one_agent_never_null', '0 null results',
  format('%s null results', count(*) filter (where public.dryrun_nep('whatsapp', g.p) is null)),
  count(*) filter (where public.dryrun_nep('whatsapp', g.p) is null) = 0
from generate_series(0, 50) g(p);

-- ═══════════════════════════════════════════════════════════════════════════
-- S4: no eligible agents -> NULL is correct (invariant 6).
-- ═══════════════════════════════════════════════════════════════════════════
update probe_profiles set availability = 'break' where id = ${A(1)};

insert into dryrun_results select 'S4_all_unavailable_is_null', 'NULL',
  coalesce(public.dryrun_nep('whatsapp', 1)::text, 'NULL'),
  public.dryrun_nep('whatsapp', 1) is null;

-- ═══════════════════════════════════════════════════════════════════════════
-- S5: one agent returns -> selection works again (invariant 7 precondition).
-- ═══════════════════════════════════════════════════════════════════════════
update probe_profiles set availability = 'available' where id = ${A(2)};

insert into dryrun_results select 'S5_recovery_after_empty', 'A2',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', 1)), 'NULL'),
  public.dryrun_nep('whatsapp', 1) = ${A(2)};

-- ═══════════════════════════════════════════════════════════════════════════
-- S6: a NULL rotation position is never selected (RC-5).
-- ═══════════════════════════════════════════════════════════════════════════
update probe_profiles set availability = 'available' where id in (${A(1)}, ${A(2)}, ${A(3)});
insert into probe_profiles values
  (${A(4)}, 'A4_nullpos', 'agent', true, 'available', true, true, true, null, null, null);

insert into dryrun_results select 'S6_null_position_never_selected', '0 selections',
  format('%s selections of the null-position agent', count(*) filter (where public.dryrun_nep('whatsapp', g.p) = ${A(4)})),
  count(*) filter (where public.dryrun_nep('whatsapp', g.p) = ${A(4)}) = 0
from generate_series(0, 30) g(p);

insert into dryrun_results select 'S6_null_position_only_is_null', 'NULL',
  coalesce(public.dryrun_nep('whatsapp', 1)::text, 'NULL'), true
from (select 1) z;
delete from probe_profiles where id in (${A(1)}, ${A(2)}, ${A(3)});
update dryrun_results set actual = coalesce(public.dryrun_nep('whatsapp', 1)::text, 'NULL'),
                          passed = (public.dryrun_nep('whatsapp', 1) is null)
  where scenario = 'S6_null_position_only_is_null';

-- ═══════════════════════════════════════════════════════════════════════════
-- S7: agent-only participation (approved decision 2).
-- ═══════════════════════════════════════════════════════════════════════════
delete from probe_profiles;
insert into probe_profiles values
  (${A(5)}, 'Supervisor', 'sales_supervisor', true, 'available', true, true, true, 1, 1, 1),
  (${A(6)}, 'Manager',    'manager',          true, 'available', true, true, true, 2, 2, 2),
  (${A(7)}, 'RealAgent',  'agent',            true, 'available', true, true, true, 3, 3, 3);

insert into dryrun_results select 'S7_non_agents_never_selected', 'RealAgent for all positions',
  format('%s non-agent selections', count(*) filter (where public.dryrun_nep('whatsapp', g.p) in (${A(5)}, ${A(6)}))),
  count(*) filter (where public.dryrun_nep('whatsapp', g.p) in (${A(5)}, ${A(6)})) = 0
from generate_series(0, 10) g(p);

insert into dryrun_results select 'S7_agent_selected_despite_lower_supervisor', 'RealAgent',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', 0)), 'NULL'),
  public.dryrun_nep('whatsapp', 0) = ${A(7)};

-- ═══════════════════════════════════════════════════════════════════════════
-- S8: inactive agents are never selected.
-- ═══════════════════════════════════════════════════════════════════════════
delete from probe_profiles;
insert into probe_profiles values
  (${A(1)}, 'Inactive', 'agent', false, 'available', true, true, true, 1, 1, 1),
  (${A(2)}, 'Active',   'agent', true,  'available', true, true, true, 2, 2, 2);

insert into dryrun_results select 'S8_inactive_never_selected', 'Active',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', 0)), 'NULL'),
  public.dryrun_nep('whatsapp', 0) = ${A(2)};

insert into dryrun_results select 'S8_inactive_wrap_still_skips', 'Active',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', 2)), 'NULL'),
  public.dryrun_nep('whatsapp', 2) = ${A(2)};

-- ═══════════════════════════════════════════════════════════════════════════
-- S9: per-rotation independence of the enable flags.
-- ═══════════════════════════════════════════════════════════════════════════
delete from probe_profiles;
insert into probe_profiles values
  (${A(1)}, 'WaOnly', 'agent', true, 'available', true,  false, false, 1, 1, 1),
  (${A(2)}, 'RcOnly', 'agent', true, 'available', false, true,  false, 2, 2, 2),
  (${A(3)}, 'WlOnly', 'agent', true, 'available', false, false, true,  3, 3, 3);

insert into dryrun_results select 'S9_whatsapp_picks_WaOnly', 'WaOnly',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', 0)), 'NULL'),
  public.dryrun_nep('whatsapp', 0) = ${A(1)};
insert into dryrun_results select 'S9_ringcentral_picks_RcOnly', 'RcOnly',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('ringcentral', 0)), 'NULL'),
  public.dryrun_nep('ringcentral', 0) = ${A(2)};
insert into dryrun_results select 'S9_workload_picks_WlOnly', 'WlOnly',
  coalesce((select display_name from probe_profiles where id = public.dryrun_nep('workload', 0)), 'NULL'),
  public.dryrun_nep('workload', 0) = ${A(3)};
insert into dryrun_results select 'S9_each_rotation_wraps_to_its_own', 'each self-loops',
  format('wa=%s rc=%s wl=%s',
    (select display_name from probe_profiles where id = public.dryrun_nep('whatsapp', 1)),
    (select display_name from probe_profiles where id = public.dryrun_nep('ringcentral', 2)),
    (select display_name from probe_profiles where id = public.dryrun_nep('workload', 3))),
  public.dryrun_nep('whatsapp', 1) = ${A(1)}
  and public.dryrun_nep('ringcentral', 2) = ${A(2)}
  and public.dryrun_nep('workload', 3) = ${A(3)};

-- ═══════════════════════════════════════════════════════════════════════════
-- S10: determinism — repeated identical calls agree.
-- ═══════════════════════════════════════════════════════════════════════════
insert into dryrun_results select 'S10_deterministic_repeat', 'identical across 3 calls',
  format('%s / %s / %s',
    public.dryrun_nep('whatsapp', 0), public.dryrun_nep('whatsapp', 0), public.dryrun_nep('whatsapp', 0)),
  public.dryrun_nep('whatsapp', 0) = public.dryrun_nep('whatsapp', 0)
  and public.dryrun_nep('whatsapp', 0) is not distinct from public.dryrun_nep('whatsapp', 0);

-- ═══════════════════════════════════════════════════════════════════════════
-- S11: the shape guarantees, read from the installed function.
-- ═══════════════════════════════════════════════════════════════════════════
insert into dryrun_results
select 'S11_wraparound_in_order_by', 'true',
       (pg_get_functiondef(p.oid) ~* 'order by[\\s\\S]*case[\\s\\S]*>[\\s]*p_after_position')::text,
       (pg_get_functiondef(p.oid) ~* 'order by[\\s\\S]*case[\\s\\S]*>[\\s]*p_after_position')
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='next_eligible_profile';

insert into dryrun_results
select 'S11_position_NOT_in_where', 'false (must not be in WHERE)',
       (pg_get_functiondef(p.oid) ~* 'and[\\s]+case[\\s\\S]*>[\\s]*p_after_position[\\s\\S]*order by')::text,
       not (pg_get_functiondef(p.oid) ~* 'and[\\s]+case[\\s\\S]*>[\\s]*p_after_position[\\s\\S]*order by')
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname='next_eligible_profile';

insert into dryrun_results
select 'S11_helpers_installed', '5 helpers',
       format('%s: %s', count(*), string_agg(p.proname, ', ' order by p.proname)),
       count(*) = 5
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in ('advance_rotation','ensure_rotation_valid','is_rotation_eligible',
                    'rotation_position_of','rotation_empty_reason');

-- ═══════════════════════════════════════════════════════════════════════════
-- S12: duplicate positions are PREVENTED by partial unique indexes, so the
--      non-determinism risk is unreachable for active agents.
-- ═══════════════════════════════════════════════════════════════════════════
insert into dryrun_results
select 'S12_duplicate_positions_prevented', '3 partial unique indexes',
       format('%s: %s', count(*), string_agg(indexname, ', ' order by indexname)),
       count(*) = 3
from pg_indexes
where schemaname='public' and tablename='profiles'
  and indexname in ('profiles_whatsapp_position_unique',
                    'profiles_ringcentral_position_unique',
                    'profiles_workload_position_unique');

-- ═══════════════════════════════════════════════════════════════════════════
-- S13: the empty-queue diagnostic returns a specific, non-generic message.
-- ═══════════════════════════════════════════════════════════════════════════
insert into dryrun_results
select 'S13_empty_reason_specific', 'mentions the queue name',
       public.rotation_empty_reason('ringcentral'),
       public.rotation_empty_reason('ringcentral') ilike '%Customer Service Intake Queue%';

insert into dryrun_results
select 'S13_empty_reason_not_generic', 'not "No agent available"',
       public.rotation_empty_reason('whatsapp'),
       public.rotation_empty_reason('whatsapp') not ilike '%no agent available%';

-- ═══════════════════════════════════════════════════════════════════════════
-- Report
-- ═══════════════════════════════════════════════════════════════════════════
select scenario, expected, actual,
       case when passed then 'PASS' else 'FAIL' end as result
from dryrun_results
order by scenario;
`;

const full = `begin;\n${body}\n${scenarios}\nrollback;\n`;

// ── Safety validation before sending ──────────────────────────────────────────
const decomment = (s) =>
  s
    .split("\n")
    .map((l) => {
      const i = l.indexOf("--");
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n")
    .toLowerCase();

const sFull = decomment(full);
const sScenarios = decomment(scenarios);
const fail = (m) => {
  console.error(`REFUSING: ${m}`);
  process.exit(1);
};

if ((sFull.match(/^\s*begin;/gm) ?? []).length !== 1) fail("expected exactly one BEGIN");
if ((sFull.match(/^\s*rollback;/gm) ?? []).length !== 1) fail("expected exactly one ROLLBACK");
if (/^\s*commit;/m.test(sFull)) fail("a COMMIT is present");
for (const banned of [/\btruncate\b/, /\bdrop\s+schema\b/, /\bdrop\s+database\b/, /\balter\s+table\b/, /\bdrop\s+table\b/]) {
  if (banned.test(sFull)) fail(`destructive statement ${banned}`);
}

// The scenario block must only ever write to the two TEMPORARY tables.
const TEMP_TABLES = ["probe_profiles", "dryrun_results"];
for (const stmt of sScenarios.split(";")) {
  const s = stmt.trim();
  if (!s || !/^(insert|update|delete)\b/.test(s)) continue;
  if (!TEMP_TABLES.some((t) => s.includes(t))) {
    fail(`scenario write does not target a temp table: ${s.slice(0, 160)}`);
  }
  for (const prod of ["public.profiles", "public.rotation_state", "public.turn_events", "public.work_items", "public.cs_intake_submissions"]) {
    if (s.includes(prod)) fail(`scenario write touches ${prod}: ${s.slice(0, 160)}`);
  }
}

console.log("SCENARIO DRY RUN — v1.8.7 installed, selector mirrored onto a TEMP table, then ROLLBACK");
console.log("No production row is written at any point.\n");

const fpSql = `
  select
    (select count(*) from public.profiles) as profiles_ct,
    (select md5(string_agg(id::text || availability::text || is_active::text ||
                coalesce(whatsapp_position::text,'-'), ',' order by id)) from public.profiles) as profiles_md5,
    (select md5(string_agg(kind::text || coalesce(current_profile_id::text,'-') || version::text,
                ',' order by kind)) from public.rotation_state) as rotation_md5,
    (select count(*) from public.turn_events) as turn_events_ct,
    (select count(*) from public.work_items) as work_items_ct,
    (select count(*) from public.cs_intake_submissions) as intakes_ct;`;

const before = JSON.parse((await q(fpSql)).text)[0];
console.log(`Pre-run : profiles=${before.profiles_ct} rotation=${before.rotation_md5?.slice(0, 12)} turn_events=${before.turn_events_ct} work_items=${before.work_items_ct} intakes=${before.intakes_ct}\n`);

const res = await q(full);
let results = [];
if (!res.ok) {
  let msg = res.text;
  try { msg = JSON.parse(res.text).message ?? res.text; } catch {}
  console.log(`RUN RESULT: ERROR (HTTP ${res.status})`);
  console.log(String(msg).slice(0, 2500));
  process.exitCode = 1;
} else {
  results = JSON.parse(res.text);
  const pass = results.filter((r) => r.result === "PASS").length;
  console.log("─── SCENARIO RESULTS ───");
  for (const r of results) {
    console.log(`  [${r.result}] ${String(r.scenario).padEnd(44)} expected=${String(r.expected).padEnd(30)} actual=${r.actual}`);
  }
  console.log(`\n  ${pass}/${results.length} scenarios passed`);
  if (pass !== results.length) process.exitCode = 1;
}

const after = JSON.parse((await q(fpSql)).text)[0];
const same = JSON.stringify(before) === JSON.stringify(after);
console.log(`\nRollback verification: production data ${same ? "UNCHANGED" : "*** CHANGED — INVESTIGATE ***"}`);
if (!same) {
  console.log("  before:", JSON.stringify(before));
  console.log("  after :", JSON.stringify(after));
  process.exitCode = 1;
}

const fnCheck = JSON.parse(
  (await q(`select count(*) as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and p.proname in ('advance_rotation','ensure_rotation_valid','dryrun_nep');`)).text,
)[0];
console.log(`New functions persisted after rollback: ${fnCheck.n} (must be 0)`);
if (Number(fnCheck.n) !== 0) process.exitCode = 1;

mkdirSync(resolve(import.meta.dirname, "..", "evidence"), { recursive: true });
writeFileSync(
  resolve(import.meta.dirname, "..", "evidence", "dry-run-scenarios.json"),
  JSON.stringify({ capturedAt: new Date().toISOString(), before, after, rollbackClean: same, functionsPersisted: fnCheck.n, results }, null, 2),
);
console.log("Wrote evidence/dry-run-scenarios.json");
