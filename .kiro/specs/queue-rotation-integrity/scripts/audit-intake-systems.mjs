/** READ-ONLY: which intake system is live, and does cs_intake_claim_ringcentral qualify? */
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
  // Which intake table is actually being written to?
  intake_volume: `
    select 'cs_intake_submissions' as tbl,
           count(*) as total,
           count(*) filter (where created_at > now() - interval '30 days') as last_30d,
           max(created_at) as newest
    from public.cs_intake_submissions
    union all
    select 'customer_intakes',
           count(*),
           count(*) filter (where created_at > now() - interval '30 days'),
           max(created_at)
    from public.customer_intakes;`,

  cs_status_breakdown: `
    select status::text as status, intake_channel, count(*) as n,
           max(submitted_at) as newest_submitted
    from public.cs_intake_submissions
    group by 1,2 order by 1,2;`,

  customer_intakes_breakdown: `
    select status::text as status, source_type, count(*) as n, max(created_at) as newest
    from public.customer_intakes
    group by 1,2 order by 1,2;`,

  // Did cs_intake_claim_ringcentral ever actually run in production?
  cs_rc_claim_usage: `
    select event_type, count(*) as n, min(created_at) as first_at, max(created_at) as last_at
    from public.cs_intake_events
    where event_type in ('ringcentral_claimed','ringcentral_claim_recovered',
                         'claimed','converted','manager_assigned','submitted')
    group by event_type order by event_type;`,

  // Manual quote / non-advancing functions: confirm they do not touch rotation_state.
  manual_fns: `
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
           (pg_get_functiondef(p.oid) ~* 'update\\s+public\\.rotation_state') as touches_rotation_state,
           (pg_get_functiondef(p.oid) ~* 'insert into public\\.turn_events')  as writes_turn_events,
           (pg_get_functiondef(p.oid) ~* 'current_profile_id')                as reads_current_agent
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public'
      and p.proname in ('log_manual_quote','log_manual_quote_v094','log_manual_workload',
                        'log_payment_v094','manager_create_and_assign_quote_v094',
                        'cs_intake_claim','cs_intake_convert','cs_intake_manager_assign',
                        'assign_customer_intake','workload_reassign','workload_void',
                        'log_whatsapp_update')
    order by p.proname;`,

  // Full body of manager_create_and_assign_quote_v094 + log_manual_quote (manual paths).
  manual_bodies: `
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
           pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public'
      and p.proname in ('log_manual_quote','log_manual_quote_v094',
                        'manager_create_and_assign_quote_v094')
    order by p.proname;`,

  // work_items provenance: how are intake-claimed vs manual quotes distinguished?
  provenance: `
    select assignment_method::text as assignment_method,
           received_through,
           count(*) as n,
           max(created_at) as newest
    from public.work_items
    where created_at > now() - interval '90 days'
    group by 1,2
    order by n desc;`,
};

const out = {};
for (const [name, sql] of Object.entries(QUERIES)) {
  const s = sql.replace(/--.*$/gm, "").toLowerCase();
  // allow the words inside quoted regex literals; only guard statement-leading DML
  if (/^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/m.test(s)) {
    console.error("refuse " + name); process.exit(1);
  }
  process.stdout.write(`[${name}] ... `);
  try { const rows = await q(sql); out[name] = { ok: true, rows }; console.log(`ok (${rows.length})`); }
  catch (e) { out[name] = { ok: false, error: String(e.message).slice(0, 400) }; console.log("FAILED " + String(e.message).slice(0, 200)); }
}
const dir = resolve(import.meta.dirname, "..", "evidence");
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "intake-systems.json"), JSON.stringify(out, null, 2));
console.log("\nWrote evidence/intake-systems.json");
