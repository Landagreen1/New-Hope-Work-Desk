/**
 * READ-ONLY live Supabase audit for the queue-rotation-integrity spec.
 *
 * Runs a fixed set of catalog / state SELECT queries against the deployed
 * database via the Supabase Management API and writes the results to
 * .kiro/specs/queue-rotation-integrity/evidence/.
 *
 * This script performs NO writes. Every statement is a SELECT.
 *
 * Usage: node .kiro/specs/queue-rotation-integrity/scripts/live-audit.mjs [queryName]
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const root = resolve(import.meta.dirname, "..", "..", "..", "..");
const envContent = readFileSync(resolve(root, ".env.local"), "utf-8");
const env = {};
for (const line of envContent.split("\n")) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

const accessToken = env.SUPABASE_ACCESS_TOKEN;
const projectRef = env.SUPABASE_PROJECT_REF;
if (!accessToken || !projectRef) {
  console.error("Missing SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF");
  process.exit(1);
}

const evidenceDir = resolve(import.meta.dirname, "..", "evidence");
mkdirSync(evidenceDir, { recursive: true });

async function q(sql) {
  const response = await fetch(
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
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Read-only audit queries
// ---------------------------------------------------------------------------
const QUERIES = {
  // 1. Which rotation-related functions actually exist live, with arg signatures.
  fn_inventory: `
    select
      p.proname                                as name,
      pg_get_function_identity_arguments(p.oid) as args,
      p.prosecdef                              as security_definer,
      l.lanname                                as lang,
      md5(pg_get_functiondef(p.oid))           as body_md5,
      length(pg_get_functiondef(p.oid))        as body_len
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where n.nspname = 'public'
      and (
        p.proname ~ '(rotation|eligible|availability|pass_my_turn|claim|take_quote|timed_quote|workload|intake)'
      )
    order by p.proname, args;
  `,

  // 2. Full live source of the core rotation engine.
  fn_bodies_core: `
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
           pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'next_eligible_profile','set_my_availability','pass_my_turn',
        'ensure_daily_availability_reset','is_agent','current_business_date'
      )
    order by p.proname;
  `,

  // 3. Full live source of every claim / turn-consuming function.
  fn_bodies_claims: `
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig,
           pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'claim_whatsapp_quote','claim_whatsapp_quote_v094',
        'claim_ringcentral_quote','claim_ringcentral_quote_v094',
        'claim_linked_workload_turn','claim_linked_workload_turn_v094',
        'claim_unlinked_workload_turn','claim_unlinked_workload_turn_v094',
        'claim_workload_turn',
        'take_quote_turn','start_quote_take_timer','start_quote_take_timer_v094',
        'claim_timed_quote','steal_timed_quote',
        'cs_intake_claim','cs_intake_claim_ringcentral','cs_intake_convert',
        'cs_intake_manager_assign','claim_ringcentral_intake',
        'log_manual_quote','log_manual_quote_v094','log_manual_workload',
        'log_payment_v094','manager_create_and_assign_quote_v094'
      )
    order by p.proname;
  `,

  // 4. Applied migration history as recorded by Supabase.
  migrations: `
    select version, name
    from supabase_migrations.schema_migrations
    order by version;
  `,

  // 5. Live rotation state.
  rotation_state: `
    select r.kind, r.current_profile_id, p.display_name, p.role::text as role,
           p.is_active, p.availability::text as availability,
           p.whatsapp_active, p.ringcentral_active, p.workload_active,
           p.whatsapp_position, p.ringcentral_position, p.workload_position,
           r.version, r.updated_at, r.updated_by
    from public.rotation_state r
    left join public.profiles p on p.id = r.current_profile_id
    order by r.kind;
  `,

  // 6. Every profile that participates in any rotation.
  profiles: `
    select id, display_name, role::text as role, is_active,
           availability::text as availability,
           whatsapp_active, whatsapp_position,
           ringcentral_active, ringcentral_position,
           workload_active, workload_position
    from public.profiles
    where role::text in ('agent','manager','super_admin','sales_supervisor')
    order by role::text, whatsapp_position nulls last, display_name;
  `,

  // 7. INVARIANT CHECK: rotation null while eligible agents exist,
  //    or current agent no longer eligible.
  invariant_violations: `
    with elig as (
      select r.kind,
             count(p.id) filter (
               where p.is_active
                 and p.availability::text = 'available'
                 and case r.kind::text
                       when 'whatsapp' then p.whatsapp_active
                       when 'ringcentral' then p.ringcentral_active
                       else p.workload_active
                     end
                 and case r.kind::text
                       when 'whatsapp' then p.whatsapp_position
                       when 'ringcentral' then p.ringcentral_position
                       else p.workload_position
                     end is not null
             ) as eligible_count
      from public.rotation_state r
      cross join public.profiles p
      group by r.kind
    )
    select r.kind::text as rotation,
           r.current_profile_id,
           cp.display_name as current_name,
           cp.role::text   as current_role,
           e.eligible_count,
           case
             when r.current_profile_id is null and e.eligible_count > 0
               then 'VIOLATION: null current agent but eligible agents exist'
             when r.current_profile_id is not null and (
                    cp.id is null
                    or not cp.is_active
                    or cp.availability::text <> 'available'
                    or not case r.kind::text
                             when 'whatsapp' then cp.whatsapp_active
                             when 'ringcentral' then cp.ringcentral_active
                             else cp.workload_active
                           end
                    or case r.kind::text
                         when 'whatsapp' then cp.whatsapp_position
                         when 'ringcentral' then cp.ringcentral_position
                         else cp.workload_position
                       end is null
                  )
               then 'VIOLATION: current agent is not eligible'
             when r.current_profile_id is null and e.eligible_count = 0
               then 'OK: legitimately empty'
             else 'OK'
           end as verdict
    from public.rotation_state r
    left join public.profiles cp on cp.id = r.current_profile_id
    join elig e on e.kind = r.kind
    order by r.kind;
  `,

  // 8. Position hygiene: nulls, duplicates, gaps.
  position_hygiene: `
    select 'whatsapp' as rotation, whatsapp_position as pos, count(*) as agents,
           string_agg(display_name, ', ') as who
    from public.profiles
    where is_active and whatsapp_active
    group by whatsapp_position
    having count(*) > 1 or whatsapp_position is null
    union all
    select 'ringcentral', ringcentral_position, count(*), string_agg(display_name, ', ')
    from public.profiles
    where is_active and ringcentral_active
    group by ringcentral_position
    having count(*) > 1 or ringcentral_position is null
    union all
    select 'workload', workload_position, count(*), string_agg(display_name, ', ')
    from public.profiles
    where is_active and workload_active
    group by workload_position
    having count(*) > 1 or workload_position is null;
  `,

  // 9. Recent turn events.
  turn_events: `
    select t.created_at, t.rotation::text as rotation, t.action::text as action,
           a.display_name as actor, pv.display_name as previous,
           nx.display_name as next, t.next_profile_id is null as went_null,
           t.work_item_id, t.reason
    from public.turn_events t
    left join public.profiles a  on a.id  = t.actor_profile_id
    left join public.profiles pv on pv.id = t.previous_profile_id
    left join public.profiles nx on nx.id = t.next_profile_id
    order by t.created_at desc
    limit 120;
  `,

  // 10. Turn events that nulled a rotation.
  null_transitions: `
    select t.created_at, t.rotation::text as rotation, t.action::text as action,
           a.display_name as actor, t.reason
    from public.turn_events t
    left join public.profiles a on a.id = t.actor_profile_id
    where t.next_profile_id is null
    order by t.created_at desc
    limit 60;
  `,

  // 11. Duplicate-claim detector: >1 turn_events for the same work_item.
  duplicate_turn_events: `
    select work_item_id, rotation::text as rotation, count(*) as events,
           min(created_at) as first_at, max(created_at) as last_at
    from public.turn_events
    where work_item_id is not null
    group by work_item_id, rotation
    having count(*) > 1
    order by max(created_at) desc
    limit 50;
  `,

  // 12. Incomplete CS intake conversions (claimed but never converted).
  stuck_intakes: `
    select id, status::text as status, intake_channel, claimed_by, claimed_at,
           work_item_id, submitted_at, line_of_business::text as lob
    from public.cs_intake_submissions
    where status::text = 'claimed' and work_item_id is null
    order by claimed_at desc nulls last
    limit 50;
  `,

  // 13. Which intake tables actually exist (two competing systems?).
  intake_tables: `
    select c.relname as table_name, c.reltuples::bigint as approx_rows
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and (c.relname like '%intake%' or c.relname like '%rotation%'
           or c.relname like '%turn%' or c.relname like '%timer%'
           or c.relname like '%quote_take%')
    order by c.relname;
  `,

  // 14. Realtime publication membership for the tables the UI subscribes to.
  realtime: `
    select schemaname, tablename
    from pg_publication_tables
    where pubname = 'supabase_realtime'
    order by tablename;
  `,

  // 15. rotation_state row count / kinds present.
  rotation_kinds: `
    select unnest(enum_range(null::public.rotation_kind))::text as kind;
  `,
};

const only = process.argv[2];
const names = only ? [only] : Object.keys(QUERIES);

// Merge into any existing results so running a single query does not clobber
// previously captured evidence.
const outFilePath = resolve(evidenceDir, "live-audit.json");
let summary = {};
if (only) {
  try {
    summary = JSON.parse(readFileSync(outFilePath, "utf-8"));
  } catch {
    summary = {};
  }
}

for (const name of names) {
  const sql = QUERIES[name];
  if (!sql) {
    console.error(`Unknown query: ${name}`);
    process.exit(1);
  }
  // Hard guarantee: read-only.
  const stripped = sql.replace(/--.*$/gm, "").toLowerCase();
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/.test(stripped)) {
    console.error(`REFUSING: query "${name}" contains a write keyword.`);
    process.exit(1);
  }

  process.stdout.write(`[${name}] ... `);
  try {
    const rows = await q(sql);
    summary[name] = { ok: true, rowCount: Array.isArray(rows) ? rows.length : 0, rows };
    console.log(`ok (${Array.isArray(rows) ? rows.length : 0} rows)`);
  } catch (err) {
    summary[name] = { ok: false, error: String(err.message).slice(0, 600) };
    console.log(`FAILED: ${String(err.message).slice(0, 200)}`);
  }
}

mkdirSync(dirname(outFilePath), { recursive: true });
writeFileSync(outFilePath, JSON.stringify(summary, null, 2));
console.log(`\nWrote ${outFilePath}`);
