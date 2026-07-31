/**
 * BEHAVIOURAL DRY RUN.
 *
 * Installs v1.8.7 inside a transaction, exercises the fixed rotation engine
 * against real production data using SELECT-only probes, prints the results, and
 * then ROLLS BACK. Nothing persists.
 *
 * This is the strongest verification available without deploying: it proves the
 * corrected SQL produces the right answers on the actual roster, rather than
 * only that it compiles.
 *
 * Probes are read-only (`next_eligible_profile` and `is_rotation_eligible` are
 * STABLE). No data statement is executed, and the whole thing is rolled back.
 */
import { readFileSync, writeFileSync } from "fs";
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
const migration = readFileSync(migrationPath, "utf-8");

// Strip the transaction control so we can append probes before rolling back.
const stripLineComments = (s) =>
  s
    .split("\n")
    .map((l) => {
      const i = l.indexOf("--");
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n");

const code = stripLineComments(migration).toLowerCase();
for (const banned of [/\bdrop\s+table\b/, /\btruncate\b/, /\bdelete\s+from\b/, /\balter\s+table\b/]) {
  if (banned.test(code)) {
    console.error(`REFUSING: destructive statement ${banned}`);
    process.exit(1);
  }
}

const body = migration
  .replace(/^([ \t]*)begin;[ \t]*$/m, "")
  .replace(/^([ \t]*)commit;[ \t]*$/m, "");

if (/^\s*(begin|commit);/m.test(stripLineComments(body))) {
  console.error("REFUSING: could not strip transaction control cleanly.");
  process.exit(1);
}

// ── Probe suite, run AFTER the fix is installed, still inside the transaction ──
// The Management API returns only the FINAL result set, so every probe is folded
// into one UNION ALL query producing (probe, subject, detail) text triples.
const probes = `
with
kinds as (select unnest(enum_range(null::public.rotation_kind)) as kind),

p1 as (
  select 'P1_selector_matrix' as probe,
         k.kind::text as subject,
         format('eligible=%s  null_results=%s of %s probes',
           (select count(*) from public.profiles p where public.is_rotation_eligible(p.id, k.kind)),
           count(*) filter (where public.next_eligible_profile(k.kind, pos.p) is null),
           count(*)) as detail
  from kinds k cross join generate_series(1, 20) pos(p)
  group by k.kind
),

p2 as (
  select 'P2_resolution' as probe, k.kind::text as subject,
         string_agg(format('%s->%s', pos.p,
           coalesce((select pr.display_name from public.profiles pr
                     where pr.id = public.next_eligible_profile(k.kind, pos.p)), '<<NULL>>')),
           '  ' order by pos.p) as detail
  from kinds k cross join generate_series(1, 12) pos(p)
  group by k.kind
),

elig as (
  select k.kind,
         min(public.rotation_position_of(p.id, k.kind)) as lo,
         max(public.rotation_position_of(p.id, k.kind)) as hi
  from kinds k join public.profiles p on public.is_rotation_eligible(p.id, k.kind)
  group by k.kind
),

p3 as (
  select 'P3_wraparound' as probe, e.kind::text as subject,
         format('lo=%s hi=%s  from_highest=%s  lowest=%s  wraps_correctly=%s',
           e.lo, e.hi,
           coalesce(w.display_name, '<<NULL>>'),
           coalesce(l.display_name, '<<NULL>>'),
           (public.next_eligible_profile(e.kind, e.hi) = l.id)) as detail
  from elig e
  left join public.profiles w on w.id = public.next_eligible_profile(e.kind, e.hi)
  left join public.profiles l on l.id = (
    select p2.id from public.profiles p2
    where public.is_rotation_eligible(p2.id, e.kind)
    order by public.rotation_position_of(p2.id, e.kind), p2.id limit 1)
),

p4 as (
  select 'P4_from_own_position' as probe,
         format('%s / %s (pos %s)', k.kind::text, p.display_name,
                public.rotation_position_of(p.id, k.kind)) as subject,
         coalesce(nx.display_name, '<<NULL>>') as detail
  from kinds k
  join public.profiles p on public.is_rotation_eligible(p.id, k.kind)
  left join public.profiles nx
    on nx.id = public.next_eligible_profile(k.kind, public.rotation_position_of(p.id, k.kind))
),

p5 as (
  select 'P5_null_after_position' as probe, k.kind::text as subject,
         coalesce((select pr.display_name from public.profiles pr
                   where pr.id = public.next_eligible_profile(k.kind, null)), '<<NULL>>') as detail
  from kinds k
),

p6 as (
  select 'P6_null_position_excluded' as probe, 'all rotations' as subject,
         format('%s agents with a null position were marked eligible (must be 0)',
           (select count(*) from public.profiles p cross join kinds k
            where public.rotation_position_of(p.id, k.kind) is null
              and public.is_rotation_eligible(p.id, k.kind))) as detail
),

p7 as (
  select 'P7_agent_only' as probe, 'all rotations' as subject,
         format('%s non-agent profiles were marked eligible (must be 0)',
           (select count(*) from public.profiles p cross join kinds k
            where p.role::text <> 'agent' and public.is_rotation_eligible(p.id, k.kind))) as detail
),

p8 as (
  select 'P8_empty_reason' as probe, k.kind::text as subject,
         public.rotation_empty_reason(k.kind) as detail
  from kinds k
),

p9 as (
  select 'P9_shape' as probe, 'next_eligible_profile' as subject,
         format('wraparound_in_order_by=%s  null_position_guard=%s  position_in_where=%s',
           (pg_get_functiondef(p.oid) ~* 'order by[\\s\\S]*case[\\s\\S]*>[\\s]*p_after_position'),
           (pg_get_functiondef(p.oid) ~* 'is not null'),
           (pg_get_functiondef(p.oid) ~* 'and[\\s]+case[\\s\\S]*>[\\s]*p_after_position[\\s\\S]*order by')) as detail
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='next_eligible_profile'
),

p10 as (
  select 'P10_helpers_installed' as probe, 'functions' as subject,
         string_agg(p.proname, ', ' order by p.proname) as detail
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname in ('advance_rotation','ensure_rotation_valid',
                      'is_rotation_eligible','rotation_position_of','rotation_empty_reason')
)

select probe, subject, detail from p1
union all select probe, subject, detail from p2
union all select probe, subject, detail from p3
union all select probe, subject, detail from p4
union all select probe, subject, detail from p5
union all select probe, subject, detail from p6
union all select probe, subject, detail from p7
union all select probe, subject, detail from p8
union all select probe, subject, detail from p9
union all select probe, subject, detail from p10
order by probe, subject;
`;

const full = `begin;\n${body}\n${probes}\nrollback;\n`;

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

const fpSql = `
  select p.proname, md5(pg_get_functiondef(p.oid)) as body_md5
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in (
    'next_eligible_profile','is_rotation_eligible','rotation_position_of',
    'rotation_empty_reason','advance_rotation','ensure_rotation_valid',
    'pass_my_turn','set_my_availability','manager_set_rotation_eligibility',
    'claim_timed_quote','steal_timed_quote')
  order by p.proname, body_md5;`;

const before = JSON.parse((await q(fpSql)).text);

console.log("BEHAVIOURAL DRY RUN — v1.8.7 installed, probed, then rolled back\n");
const res = await q(full);

if (!res.ok) {
  let msg = res.text;
  try { msg = JSON.parse(res.text).message ?? res.text; } catch {}
  console.log(`RESULT: FAIL (HTTP ${res.status})`);
  console.log(String(msg).slice(0, 2000));
  process.exitCode = 1;
} else {
  const rows = JSON.parse(res.text);
  const byProbe = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    (byProbe[r.probe ?? "unknown"] ??= []).push(r);
  }

  for (const [probe, list] of Object.entries(byProbe)) {
    console.log(`\n─── ${probe} ───`);
    for (const r of list) {
      console.log(`  ${String(r.subject).padEnd(34)} ${r.detail}`);
    }
  }
  writeFileSync(
    resolve(import.meta.dirname, "..", "evidence", "dry-run-behavior.json"),
    JSON.stringify({ capturedAt: new Date().toISOString(), probes: byProbe }, null, 2),
  );
  console.log("\nWrote evidence/dry-run-behavior.json");
}

const after = JSON.parse((await q(fpSql)).text);
const unchanged = JSON.stringify(before) === JSON.stringify(after);
console.log(
  `\nRollback verification: ${unchanged ? "function definitions UNCHANGED (rollback confirmed)" : "*** CHANGED — INVESTIGATE ***"}`,
);
if (!unchanged) process.exitCode = 1;

