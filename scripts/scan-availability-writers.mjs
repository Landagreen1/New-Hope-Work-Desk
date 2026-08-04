/**
 * Read-only: enumerate every function in schema public whose pg_get_functiondef
 * mentions "availability", classify it as a writer or reader of profiles.availability,
 * and confirm the enum members / absence of the new objects this bugfix introduces.
 *
 * Usage: node scripts/scan-availability-writers.mjs
 * Performs SELECT statements only.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

const root = resolve(import.meta.dirname, '..');
const envContent = readFileSync(join(root, '.env.local'), 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}
const accessToken = env.SUPABASE_ACCESS_TOKEN;
const projectRef = env.SUPABASE_PROJECT_REF;
if (!accessToken || !projectRef) {
  console.error('Missing SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF in .env.local');
  process.exit(1);
}

async function query(sql) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ query: sql }),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`Failed (${response.status}): ${text}`);
  return JSON.parse(text);
}

const outDir = join(root, '.kiro', 'specs', 'attendance-queue-status-separation', 'evidence');
mkdirSync(outDir, { recursive: true });

// ---------- 1. every public function mentioning "availability" ----------
const fns = await query(`
  select
    p.proname as name,
    pg_get_function_identity_arguments(p.oid) as args,
    p.prosecdef as security_definer,
    pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and pg_get_functiondef(p.oid) ilike '%availability%'
  order by p.proname
`);

// A "writer" performs an UPDATE/INSERT that targets the availability column,
// or delegates to a function that does.
const delegates = ['set_my_availability', 'ensure_daily_availability_reset'];
const classify = (def) => {
  const d = def.toLowerCase();
  const writes =
    /update\s+(public\.)?profiles[\s\S]{0,600}?\bset\b[\s\S]{0,600}?\bavailability\b/.test(d) ||
    /insert\s+into\s+(public\.)?profiles[\s\S]{0,600}?availability/.test(d) ||
    /\bavailability\s*(=|:=)\s*/.test(d) === false ? false : false;
  return writes;
};

const scan = fns.map((f) => {
  const d = f.def.toLowerCase();
  const directUpdate = /update\s+(public\.)?profiles\b[\s\S]*?\bset\b[\s\S]*?\bavailability\s*=/.test(d);
  const directInsert = /insert\s+into\s+(public\.)?profiles\b[\s\S]*?\bavailability\b/.test(d);
  const calledDelegates = delegates.filter((x) => x !== f.name && d.includes(x));
  const readsOnly = !directUpdate && !directInsert && calledDelegates.length === 0;
  const availabilityLines = f.def
    .split('\n')
    .map((line, i) => ({ n: i + 1, line: line.trim() }))
    .filter((x) => /availability/i.test(x.line));
  return {
    name: f.name,
    args: f.args,
    security_definer: f.security_definer,
    writes_availability_directly: directUpdate || directInsert,
    calls_availability_writer: calledDelegates,
    reads_only: readsOnly,
    availability_lines: availabilityLines,
  };
});

// ---------- 2. explicitly probe the live-only frontend RPCs ----------
const liveOnly = await query(`
  select
    p.proname as name,
    pg_get_function_identity_arguments(p.oid) as args,
    pg_get_functiondef(p.oid) ilike '%availability%' as mentions_availability,
    pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'claim_whatsapp_quote_v094','claim_ringcentral_quote_v094',
      'start_quote_take_timer_v094','claim_timed_quote','steal_timed_quote',
      'claim_whatsapp_quote','claim_ringcentral_quote','cs_intake_claim_ringcentral',
      'claim_linked_workload_turn','claim_unlinked_workload_turn','take_quote_turn','pass_my_turn'
    )
  order by p.proname
`);
const liveOnlyReport = liveOnly.map((f) => {
  const d = f.def.toLowerCase();
  return {
    name: f.name,
    args: f.args,
    mentions_availability: f.mentions_availability,
    writes_availability_directly:
      /update\s+(public\.)?profiles\b[\s\S]*?\bset\b[\s\S]*?\bavailability\s*=/.test(d) ||
      /insert\s+into\s+(public\.)?profiles\b[\s\S]*?\bavailability\b/.test(d),
    calls_set_my_availability: d.includes('set_my_availability'),
    availability_lines: f.def.split('\n').map((l) => l.trim()).filter((l) => /availability/i.test(l)),
  };
});

// ---------- 3. triggers / rules / views touching profiles.availability ----------
const triggers = await query(`
  select
    c.relname as table_name,
    t.tgname as trigger_name,
    pg_get_triggerdef(t.oid) as def,
    p.proname as function_name,
    pg_get_functiondef(p.oid) ilike '%availability%' as fn_mentions_availability
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_proc p on p.oid = t.tgfoid
  where n.nspname = 'public'
    and not t.tgisinternal
    and pg_get_functiondef(p.oid) ilike '%availability%'
  order by c.relname, t.tgname
`);

// ---------- 4. enums ----------
const enums = await query(`
  select t.typname as enum_name, e.enumlabel as label, e.enumsortorder as sort
  from pg_type t
  join pg_enum e on e.enumtypid = t.oid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public'
    and t.typname in ('availability_status','role','user_role','queue_status_mode','rotation_kind')
  order by t.typname, e.enumsortorder
`);

// ---------- 5. absence checks for the objects the migration introduces ----------
const absence = await query(`
  select
    (select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace
       where n.nspname='public' and t.typname='queue_status_mode')                    as enum_queue_status_mode,
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname='availability_events')                  as table_availability_events,
    (select count(*) from information_schema.columns
       where table_schema='public' and table_name='profiles'
         and column_name='queue_status_mode')                                          as col_profiles_queue_status_mode,
    (select count(*) from information_schema.columns
       where table_schema='public' and table_name='time_clock_breaks'
         and column_name='pre_break_queue_status')                                     as col_breaks_pre_break_queue_status,
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname in
         ('record_availability_event','apply_queue_status','set_my_queue_status',
          'manager_set_queue_status','manager_set_queue_status_mode',
          'attendance_clock_in','attendance_clock_out','attendance_break_start','attendance_break_end')
    )                                                                                  as fns_from_this_bugfix
`);

// ---------- 6. profiles.availability column facts ----------
const col = await query(`
  select column_name, data_type, udt_name, is_nullable, column_default
  from information_schema.columns
  where table_schema='public' and table_name='profiles' and column_name='availability'
`);

// ---------- 7. latest migration marker, if the project records one ----------
let migrations = null;
try {
  migrations = await query(`
    select version, name
    from supabase_migrations.schema_migrations
    order by version desc
    limit 10
  `);
} catch (e) {
  migrations = { error: String(e.message).slice(0, 300) };
}

const report = {
  project: projectRef,
  captured_at: new Date().toISOString(),
  functions_mentioning_availability_count: scan.length,
  functions_mentioning_availability: scan,
  claim_and_queue_functions: liveOnlyReport,
  triggers_whose_function_mentions_availability: triggers,
  enums: enums,
  absence_checks: absence[0],
  profiles_availability_column: col[0] ?? null,
  recorded_migrations_latest_10: migrations,
};

writeFileSync(join(outDir, 'live-availability-scan.json'), JSON.stringify(report, null, 2), 'utf-8');

console.log(`functions mentioning "availability": ${scan.length}`);
for (const s of scan) {
  const tag = s.writes_availability_directly
    ? 'WRITES-DIRECT'
    : s.calls_availability_writer.length
      ? `DELEGATES->${s.calls_availability_writer.join(',')}`
      : 'reads-only';
  console.log(`  ${tag.padEnd(34)} public.${s.name}(${s.args})`);
}
console.log('\nclaim/queue functions probed:');
for (const s of liveOnlyReport) {
  console.log(
    `  ${s.name.padEnd(32)} mentions=${s.mentions_availability} writesDirect=${s.writes_availability_directly} callsSetMyAvailability=${s.calls_set_my_availability}`,
  );
}
console.log('\nabsence checks:', JSON.stringify(absence[0]));
console.log('\nenums:');
const byEnum = {};
for (const e of enums) (byEnum[e.enum_name] ??= []).push(e.label);
for (const [k, v] of Object.entries(byEnum)) console.log(`  ${k}: ${v.join(' | ')}`);
console.log(`\nwrote ${join(outDir, 'live-availability-scan.json')}`);
