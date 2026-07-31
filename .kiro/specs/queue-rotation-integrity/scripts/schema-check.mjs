/** READ-ONLY schema check for the tables the migration touches. */
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
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` }, body: JSON.stringify({ query: sql }) },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t}`);
  return JSON.parse(t);
}

for (const tbl of ["turn_events", "rotation_state"]) {
  console.log(`\n=== ${tbl} columns ===`);
  const cols = await q(`
    select column_name, data_type, udt_name, is_nullable, column_default
    from information_schema.columns
    where table_schema='public' and table_name='${tbl}'
    order by ordinal_position;`);
  for (const c of cols) {
    console.log(`  ${c.column_name.padEnd(22)} ${c.data_type.padEnd(26)} udt=${(c.udt_name||'').padEnd(18)} null=${c.is_nullable} def=${c.column_default ?? ''}`);
  }
}

console.log("\n=== constraints on turn_events ===");
for (const c of await q(`
  select conname, pg_get_constraintdef(oid) as def
  from pg_constraint where conrelid='public.turn_events'::regclass;`)) {
  console.log(`  ${c.conname}: ${c.def}`);
}

console.log("\n=== enum labels ===");
for (const e of await q(`
  select t.typname, string_agg(e.enumlabel, ', ' order by e.enumsortorder) as labels
  from pg_type t join pg_enum e on e.enumtypid=t.oid
  where t.typname in ('rotation_kind','availability_status','turn_action','assignment_method','app_role')
  group by t.typname order by t.typname;`)) {
  console.log(`  ${e.typname}: ${e.labels}`);
}

console.log("\n=== grants on the functions we replace ===");
for (const g of await q(`
  select p.proname, pg_get_userbyid(p.proowner) as owner,
         coalesce(array_to_string(p.proacl::text[], ' | '), '<default>') as acl
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
    and p.proname in ('next_eligible_profile','set_my_availability','pass_my_turn',
                      'claim_timed_quote','steal_timed_quote','claim_workload_turn',
                      'manager_set_rotation_eligibility')
  order by p.proname;`)) {
  console.log(`  ${g.proname.padEnd(34)} owner=${g.owner} acl=${g.acl}`);
}
