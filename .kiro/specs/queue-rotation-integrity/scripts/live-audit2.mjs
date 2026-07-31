/**
 * READ-ONLY follow-up audit: manager eligibility functions, business date,
 * daily start rows, and the exact eligibility timeline.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const root = resolve(import.meta.dirname, "..", "..", "..", "..");
const envContent = readFileSync(resolve(root, ".env.local"), "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}
const accessToken = env.SUPABASE_ACCESS_TOKEN;
const projectRef = env.SUPABASE_PROJECT_REF;

async function q(sql) {
  const r = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${t}`);
  return JSON.parse(t);
}

const QUERIES = {
  manager_fns: `
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
           pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public'
      and p.proname in ('manager_set_rotation_eligibility','manager_set_rotation_current',
                        'manager_update_customer_service_overflow')
    order by p.proname;`,

  business_date: `
    select public.current_business_date() as business_date,
           now() as db_now,
           current_setting('TimeZone') as db_tz;`,

  business_date_fn: `
    select pg_get_functiondef(p.oid) as def
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='current_business_date';`,

  day_state: `select * from public.availability_day_state;`,

  daily_starts: `
    select business_date, rotation::text as rotation, starter_profile_id, pr.display_name
    from public.daily_rotation_starts d
    left join public.profiles pr on pr.id = d.starter_profile_id
    order by business_date desc, rotation
    limit 30;`,

  // Is there ANY audit trail for eligibility flag changes?
  eligibility_audit_tables: `
    select c.relname
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r'
      and (c.relname like '%audit%' or c.relname like '%eligib%'
           or c.relname like '%profile%' or c.relname like '%history%')
    order by c.relname;`,

  // Full current eligibility picture for every agent.
  agent_eligibility: `
    select display_name, role::text as role, is_active,
           availability::text as availability,
           whatsapp_active  as wa_on,  whatsapp_position  as wa_pos,
           ringcentral_active as rc_on, ringcentral_position as rc_pos,
           workload_active  as wl_on,  workload_position  as wl_pos
    from public.profiles
    where is_active and role::text in ('agent','sales_supervisor')
    order by whatsapp_position nulls last;`,

  // Anything at all written after the last turn event?
  recent_rotation_updates: `
    select kind::text as kind, current_profile_id, version, updated_at, updated_by,
           pr.display_name as updated_by_name
    from public.rotation_state r
    left join public.profiles pr on pr.id = r.updated_by
    order by updated_at desc;`,

  // Does turn_events have anything after 00:31:13 on 2026-07-31?
  events_after: `
    select count(*) as events_after_0031
    from public.turn_events
    where created_at > '2026-07-31 00:31:13+00';`,

  // Confirm which rotation_state kinds exist and the enum.
  timer_state: `
    select t.id, t.rotation::text as rotation, t.current_profile_id,
           pr.display_name as current_name, t.deadline_at, t.claimed_at,
           t.created_at
    from public.quote_take_timers t
    left join public.profiles pr on pr.id = t.current_profile_id
    order by t.created_at desc limit 20;`,
};

const out = {};
for (const [name, sql] of Object.entries(QUERIES)) {
  const stripped = sql.replace(/--.*$/gm, "").toLowerCase();
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/.test(stripped)) {
    console.error(`REFUSING write-ish query ${name}`);
    process.exit(1);
  }
  process.stdout.write(`[${name}] ... `);
  try {
    const rows = await q(sql);
    out[name] = { ok: true, rows };
    console.log(`ok (${rows.length})`);
  } catch (e) {
    out[name] = { ok: false, error: String(e.message).slice(0, 500) };
    console.log(`FAILED ${String(e.message).slice(0, 160)}`);
  }
}
const dir = resolve(import.meta.dirname, "..", "evidence");
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "live-audit2.json"), JSON.stringify(out, null, 2));
console.log("\nWrote live-audit2.json");
