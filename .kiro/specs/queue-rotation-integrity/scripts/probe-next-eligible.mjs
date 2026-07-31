/**
 * READ-ONLY probe of next_eligible_profile() against current live state.
 * next_eligible_profile is declared STABLE, so calling it performs no writes.
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
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` }, body: JSON.stringify({ query: sql }) },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t}`);
  return JSON.parse(t);
}

// Probe every rotation across every plausible "after position" value.
const sql = `
with probe as (
  select k.kind, pos.p as after_position,
         public.next_eligible_profile(k.kind, pos.p) as next_id
  from (values ('whatsapp'::public.rotation_kind),
               ('ringcentral'::public.rotation_kind),
               ('workload'::public.rotation_kind)) k(kind)
  cross join generate_series(1, 15) pos(p)
)
select probe.kind::text as rotation, probe.after_position,
       coalesce(pr.display_name, '<<NULL>>') as next_agent
from probe
left join public.profiles pr on pr.id = probe.next_id
order by probe.kind, probe.after_position;
`;

const rows = await q(sql);
console.log("=== next_eligible_profile(kind, after_position) on CURRENT live state ===");
const byKind = {};
for (const r of rows) {
  byKind[r.rotation] ??= [];
  byKind[r.rotation].push(`${r.after_position}->${r.next_agent}`);
}
for (const [k, v] of Object.entries(byKind)) {
  console.log(`\n${k}:`);
  console.log("  " + v.join("  "));
}

// Also probe with a NULL after_position (current agent has null position).
const nullProbe = await q(`
  select k.kind::text as rotation,
         coalesce(pr.display_name,'<<NULL>>') as next_agent
  from (values ('whatsapp'::public.rotation_kind),
               ('ringcentral'::public.rotation_kind),
               ('workload'::public.rotation_kind)) k(kind)
  left join public.profiles pr
         on pr.id = public.next_eligible_profile(k.kind, null)
  order by 1;
`);
console.log("\n=== after_position = NULL ===");
for (const r of nullProbe) console.log(`  ${r.rotation}: ${r.next_agent}`);
