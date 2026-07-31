/**
 * POST-DEPLOY VERIFICATION — replays the 2026-07-31 00:30:30 production incident
 * against the NOW-DEPLOYED v1.8.7 functions.
 *
 * The original failure: Miguel Leiva (whatsapp_position 8) went unavailable while
 * Estefania Bayas (position 5) was available and eligible. The old selector
 * required `position > 8`, found nobody, and nulled WhatsApp and RingCentral with
 * the message "no eligible agent is currently available" — which was false.
 *
 * This script recreates that exact state inside ONE transaction that ends in
 * ROLLBACK, calls the real deployed functions, and asserts the queue now wraps to
 * Estefania instead of going NULL.
 *
 * Safety:
 *   - single transaction, ends in ROLLBACK, no COMMIT anywhere
 *   - only `availability` on two named agents and `rotation_state` are touched,
 *     both restored by the rollback
 *   - no INSERT/DELETE against any data table
 *   - row counts and rotation_state are fingerprinted before and after
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const root = resolve(import.meta.dirname, "..", "..", "..", "..");
const env = {};
for (const line of readFileSync(resolve(root, ".env.local"), "utf-8").split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
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
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
        body: JSON.stringify({ query: sql }),
      },
    );
  } catch (e) {
    if (attempt < MAX) { await sleep(attempt * 3000); return q(sql, attempt + 1); }
    throw e;
  }
  const t = await r.text();
  if (!r.ok && r.status >= 500 && attempt < MAX) { await sleep(attempt * 3000); return q(sql, attempt + 1); }
  return { ok: r.ok, status: r.status, text: t };
}

const FP = `
  select
    (select count(*) from public.profiles) as profiles_ct,
    (select count(*) from public.work_items) as work_items_ct,
    (select count(*) from public.turn_events) as turn_events_ct,
    (select count(*) from public.cs_intake_submissions) as intakes_ct,
    (select count(*) from public.audit_log) as audit_ct,
    (select md5(string_agg(id::text||availability::text, ',' order by id)) from public.profiles) as avail_md5,
    (select md5(string_agg(kind::text||coalesce(current_profile_id::text,'-')||version::text, ',' order by kind))
       from public.rotation_state) as rotation_md5;`;

// Resolve the two agents by their known rotation positions.
const idsRes = await q(`
  select display_name, id, whatsapp_position
  from public.profiles
  where role='agent' and is_active and whatsapp_position in (5, 8)
  order by whatsapp_position;`);
if (!idsRes.ok) { console.error(idsRes.text.slice(0, 300)); process.exit(1); }
const agents = JSON.parse(idsRes.text);
if (agents.length !== 2) { console.error("Expected agents at whatsapp_position 5 and 8"); process.exit(1); }
const low = agents[0];   // position 5
const high = agents[1];  // position 8

console.log("POST-DEPLOY VERIFICATION — replaying the production incident");
console.log(`  low  : ${low.display_name} (whatsapp_position ${low.whatsapp_position})`);
console.log(`  high : ${high.display_name} (whatsapp_position ${high.whatsapp_position})`);
console.log("  All changes roll back.\n");

const test = `
begin;

create temporary table verify_results (check_name text, expected text, actual text, passed boolean);

-- Recreate the incident: only the two agents are available, high holds the turn.
update public.profiles set availability = 'available' where id in ('${low.id}', '${high.id}');
update public.rotation_state set current_profile_id = '${high.id}' where kind = 'whatsapp';

insert into verify_results select 'setup_two_eligible', '2',
  (select count(*)::text from public.profiles p where public.is_rotation_eligible(p.id,'whatsapp')),
  (select count(*) from public.profiles p where public.is_rotation_eligible(p.id,'whatsapp')) = 2;

-- ── THE BUG: selector called from the highest position (8) ──
insert into verify_results select 'INCIDENT_selector_from_pos8', '${low.display_name} (wraps)',
  coalesce((select display_name from public.profiles where id = public.next_eligible_profile('whatsapp', 8)), 'NULL'),
  public.next_eligible_profile('whatsapp', 8) = '${low.id}';

-- ── The real advance path the incident went through ──
insert into verify_results select 'INCIDENT_advance_from_pos8', '${low.display_name}, not NULL',
  coalesce((select display_name from public.profiles p
            join public.rotation_state r on r.current_profile_id = p.id
            where r.kind='whatsapp'), 'NULL'),
  true;
select public.advance_rotation('whatsapp', '${high.id}', 8, 'auto_skip', '${high.id}', null, null, 'post-deploy verification');
update verify_results set
  actual = coalesce((select display_name from public.profiles p
                     join public.rotation_state r on r.current_profile_id = p.id
                     where r.kind='whatsapp'), 'NULL'),
  passed = (select current_profile_id from public.rotation_state where kind='whatsapp') = '${low.id}'
  where check_name = 'INCIDENT_advance_from_pos8';

-- Exactly one turn_events row was written by that advance.
insert into verify_results select 'one_turn_event_written', '1',
  (select count(*)::text from public.turn_events
   where reason = 'post-deploy verification'),
  (select count(*) from public.turn_events where reason = 'post-deploy verification') = 1;

-- Rotation independence: rc and workload untouched by the whatsapp advance.
insert into verify_results select 'rotations_independent', 'rc+wl unchanged',
  format('rc=%s wl=%s',
    coalesce((select current_profile_id::text from public.rotation_state where kind='ringcentral'),'null'),
    coalesce((select current_profile_id::text from public.rotation_state where kind='workload'),'null')),
  (select current_profile_id from public.rotation_state where kind='ringcentral') is null
  and (select current_profile_id from public.rotation_state where kind='workload') is null;

-- ── Self-loop: only ONE agent eligible ──
update public.profiles set availability = 'unavailable' where id = '${high.id}';
update public.rotation_state set current_profile_id = '${low.id}' where kind = 'whatsapp';
select public.advance_rotation('whatsapp', '${low.id}', 5, 'claim', '${low.id}', '${low.id}', null, 'post-deploy selfloop');
insert into verify_results select 'self_loop_keeps_agent', '${low.display_name}',
  coalesce((select display_name from public.profiles p
            join public.rotation_state r on r.current_profile_id = p.id
            where r.kind='whatsapp'), 'NULL'),
  (select current_profile_id from public.rotation_state where kind='whatsapp') = '${low.id}';

-- ── Auto-recovery from NULL (invariant 7) ──
update public.rotation_state set current_profile_id = null where kind = 'whatsapp';
select public.ensure_rotation_valid('whatsapp', '${low.id}');
insert into verify_results select 'recovers_from_null', '${low.display_name}',
  coalesce((select display_name from public.profiles p
            join public.rotation_state r on r.current_profile_id = p.id
            where r.kind='whatsapp'), 'NULL'),
  (select current_profile_id from public.rotation_state where kind='whatsapp') = '${low.id}';

-- ── Repairs a pointer at an ineligible agent (invariant 5) ──
update public.rotation_state set current_profile_id = '${high.id}' where kind = 'whatsapp';
select public.ensure_rotation_valid('whatsapp', '${low.id}');
insert into verify_results select 'repairs_ineligible_pointer', '${low.display_name}',
  coalesce((select display_name from public.profiles p
            join public.rotation_state r on r.current_profile_id = p.id
            where r.kind='whatsapp'), 'NULL'),
  (select current_profile_id from public.rotation_state where kind='whatsapp') = '${low.id}';

-- ── Idempotent: a second ensure call writes nothing ──
insert into verify_results select 'ensure_valid_idempotent', 'version unchanged',
  format('v%s -> v%s', v1, v2), v1 = v2
from (select (select version from public.rotation_state where kind='whatsapp') as v1,
             (select public.ensure_rotation_valid('whatsapp','${low.id}')) as ig,
             (select version from public.rotation_state where kind='whatsapp') as v2) s;

-- ── No eligible agents at all -> NULL is accepted (invariant 6) ──
update public.profiles set availability = 'unavailable' where id in ('${low.id}', '${high.id}');
select public.ensure_rotation_valid('whatsapp', null);
insert into verify_results select 'null_when_truly_empty', 'NULL',
  coalesce((select current_profile_id::text from public.rotation_state where kind='whatsapp'), 'NULL'),
  (select current_profile_id from public.rotation_state where kind='whatsapp') is null;

select check_name, expected, actual, case when passed then 'PASS' else 'FAIL' end as result
from verify_results order by check_name;

rollback;
`;

// Safety validation
const dec = test.split("\n").map((l) => { const i = l.indexOf("--"); return i === -1 ? l : l.slice(0, i); }).join("\n").toLowerCase();
const fail = (m) => { console.error(`REFUSING: ${m}`); process.exit(1); };
if ((dec.match(/^\s*begin;/gm) ?? []).length !== 1) fail("expected one BEGIN");
if ((dec.match(/^\s*rollback;/gm) ?? []).length !== 1) fail("expected one ROLLBACK");
if (/^\s*commit;/m.test(dec)) fail("a COMMIT is present");
for (const b of [/\btruncate\b/, /\bdrop\s+table\b/, /\bdelete\s+from\s+public\./, /\balter\s+table\b/, /\binsert\s+into\s+public\./]) {
  if (b.test(dec)) fail(`disallowed statement ${b}`);
}
for (const stmt of dec.split(";")) {
  const s = stmt.trim();
  if (/^update\s+public\.profiles/.test(s) && !s.includes(low.id.toLowerCase()) && !s.includes(high.id.toLowerCase())) {
    fail(`unscoped profiles update: ${s.slice(0, 140)}`);
  }
}

const before = JSON.parse((await q(FP)).text)[0];
console.log("Before:", JSON.stringify(before), "\n");

const res = await q(test);
let results = [];
if (!res.ok) {
  let msg = res.text; try { msg = JSON.parse(res.text).message ?? res.text; } catch {}
  console.log(`RESULT: ERROR (HTTP ${res.status})`);
  console.log(String(msg).slice(0, 2000));
  process.exitCode = 1;
} else {
  results = JSON.parse(res.text);
  const pass = results.filter((r) => r.result === "PASS").length;
  console.log("─── POST-DEPLOY CHECKS (against live v1.8.7) ───");
  for (const r of results) {
    console.log(`  [${r.result}] ${String(r.check_name).padEnd(30)} expected=${String(r.expected).padEnd(26)} actual=${r.actual}`);
  }
  console.log(`\n  ${pass}/${results.length} checks passed`);
  if (pass !== results.length) process.exitCode = 1;
}

const after = JSON.parse((await q(FP)).text)[0];
const same = JSON.stringify(before) === JSON.stringify(after);
console.log(`\nRollback verification: production state ${same ? "UNCHANGED" : "*** CHANGED — INVESTIGATE ***"}`);
if (!same) { console.log(" before:", JSON.stringify(before)); console.log(" after :", JSON.stringify(after)); process.exitCode = 1; }

mkdirSync(resolve(import.meta.dirname, "..", "evidence"), { recursive: true });
writeFileSync(
  resolve(import.meta.dirname, "..", "evidence", "post-deploy-verify.json"),
  JSON.stringify({ at: new Date().toISOString(), low, high, before, after, rollbackClean: same, results }, null, 2),
);
console.log("Wrote evidence/post-deploy-verify.json");
