/** READ-ONLY: audit_log proof of eligibility toggles + timer schema. */
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
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` }, body: JSON.stringify({ query: sql }) },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t}`);
  return JSON.parse(t);
}
const QUERIES = {
  eligibility_changes: `
    select a.created_at,
           act.display_name as actor,
           tgt.display_name as target,
           a.reason,
           (a.old_value->>'whatsapp_active')   as old_wa,
           (a.new_value->>'whatsapp_active')   as new_wa,
           (a.old_value->>'ringcentral_active') as old_rc,
           (a.new_value->>'ringcentral_active') as new_rc,
           (a.old_value->>'workload_active')   as old_wl,
           (a.new_value->>'workload_active')   as new_wl,
           (a.old_value->>'availability')      as old_avail,
           (a.new_value->>'availability')      as new_avail
    from public.audit_log a
    left join public.profiles act on act.id = a.actor_profile_id
    left join public.profiles tgt on tgt.id = a.entity_id
    where a.action = 'rotation_eligibility_changed'
    order by a.created_at desc
    limit 40;`,

  all_audit_recent: `
    select a.created_at, a.action, act.display_name as actor,
           tgt.display_name as target, a.reason
    from public.audit_log a
    left join public.profiles act on act.id = a.actor_profile_id
    left join public.profiles tgt on tgt.id = a.entity_id
    order by a.created_at desc
    limit 40;`,

  timers_cols: `
    select column_name, data_type
    from information_schema.columns
    where table_schema='public' and table_name='quote_take_timers'
    order by ordinal_position;`,

  rotation_updated: `
    select r.kind::text as kind, r.current_profile_id, r.version,
           r.updated_at, pr.display_name as updated_by_name
    from public.rotation_state r
    left join public.profiles pr on pr.id = r.updated_by
    order by r.kind;`,
};
const out = {};
for (const [name, sql] of Object.entries(QUERIES)) {
  const s = sql.replace(/--.*$/gm, "").toLowerCase();
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/.test(s)) { console.error("refuse " + name); process.exit(1); }
  process.stdout.write(`[${name}] ... `);
  try { const rows = await q(sql); out[name] = { ok: true, rows }; console.log(`ok (${rows.length})`); }
  catch (e) { out[name] = { ok: false, error: String(e.message).slice(0, 400) }; console.log("FAILED " + String(e.message).slice(0, 150)); }
}
const dir = resolve(import.meta.dirname, "..", "evidence");
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "live-audit3.json"), JSON.stringify(out, null, 2));
console.log("\nWrote live-audit3.json");
