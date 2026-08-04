/**
 * Read-only: dump live pg_get_functiondef bodies for a named set of public functions
 * into .kiro/specs/attendance-queue-status-separation/evidence/live-functions/.
 *
 * Usage: node scripts/dump-live-functions.mjs
 *
 * Uses the same Supabase Management API pattern as scripts/query-sql.mjs.
 * Performs SELECT statements only.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

const root = resolve(import.meta.dirname, '..');
const envPath = join(root, '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
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
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Failed (${response.status}): ${text}`);
  }
  return JSON.parse(text);
}

const targets = [
  'set_my_availability',
  'ensure_daily_availability_reset',
  'advance_rotation',
  'ensure_rotation_valid',
  'next_eligible_profile',
  'is_rotation_eligible',
  'is_agent',
  'is_manager',
  'can_manage_sales',
  'manager_set_rotation_eligibility',
  // Third live writer of profiles.availability (evidence-report.md § 1.4). No `create function`
  // exists anywhere in supabase/, so this dump is the only source task 4.6 can transcribe from.
  'admin_deactivate_profile',
];

// Functions whose ACL must also be captured, because task 4.6 recreates them and a drop/create
// would silently drop grants that `create or replace` preserves. pg_get_functiondef emits no grants.
const aclTargets = ['admin_deactivate_profile'];

const outDir = join(root, '.kiro', 'specs', 'attendance-queue-status-separation', 'evidence', 'live-functions');
mkdirSync(outDir, { recursive: true });

const list = targets.map((t) => `'${t}'`).join(', ');
const rows = await query(`
  select
    p.proname                              as name,
    pg_get_function_identity_arguments(p.oid) as args,
    p.prosecdef                            as security_definer,
    p.provolatile                          as volatility,
    l.lanname                              as language,
    pg_get_functiondef(p.oid)              as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public'
    and p.proname in (${list})
  order by p.proname, pg_get_function_identity_arguments(p.oid)
`);

const index = [];
const seen = new Map();
for (const row of rows) {
  const suffix = seen.has(row.name) ? `__${seen.get(row.name) + 1}` : '';
  seen.set(row.name, (seen.get(row.name) ?? 0) + 1);
  const file = `${row.name}${suffix}.sql`;
  const header = [
    `-- LIVE definition dumped from Supabase project ${projectRef}`,
    `-- captured: ${new Date().toISOString()}`,
    `-- function: public.${row.name}(${row.args})`,
    `-- language: ${row.language}   security_definer: ${row.security_definer}   volatility: ${row.volatility}`,
    '-- READ-ONLY DUMP. Do not apply this file.',
    '',
  ].join('\n');
  writeFileSync(join(outDir, file), `${header}${row.def}\n`, 'utf-8');
  index.push({ name: row.name, args: row.args, file, security_definer: row.security_definer, language: row.language, bytes: row.def.length });
  console.log(`wrote ${file}  (${row.def.length} bytes)`);
}

const missing = targets.filter((t) => !seen.has(t));
writeFileSync(
  join(outDir, '_index.json'),
  JSON.stringify({ project: projectRef, captured_at: new Date().toISOString(), functions: index, missing }, null, 2),
  'utf-8',
);
if (missing.length) console.log(`MISSING in live public schema: ${missing.join(', ')}`);
console.log(`\n${index.length} definitions written to ${outDir}`);

// ---------- ACL capture ----------
// pg_get_functiondef does not emit grants. Capture p.proacl plus the
// information_schema.role_routine_grants rows so a recreate can reproduce them exactly.
for (const name of aclTargets) {
  const aclRows = await query(`
    select
      p.oid::text                                as oid,
      p.proname                                  as name,
      pg_get_function_identity_arguments(p.oid)  as identity_arguments,
      pg_get_function_arguments(p.oid)           as full_arguments,
      pg_get_function_result(p.oid)              as result_type,
      p.prosecdef                                as security_definer,
      p.provolatile                              as volatility,
      p.proparallel                              as parallel,
      p.proleakproof                            as leakproof,
      p.proconfig                                as config_settings,
      pg_get_userbyid(p.proowner)                as owner,
      p.proacl::text[]                           as proacl,
      (select count(*)
         from pg_proc p2
         join pg_namespace n2 on n2.oid = p2.pronamespace
        where n2.nspname = 'public' and p2.proname = p.proname) as overload_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = '${name}'
    order by pg_get_function_identity_arguments(p.oid)
  `);

  const grantRows = await query(`
    select grantor, grantee, specific_name, routine_name, privilege_type, is_grantable
    from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = '${name}'
    order by grantee, privilege_type
  `);

  const payload = {
    project: projectRef,
    captured_at: new Date().toISOString(),
    function: `public.${name}`,
    note:
      'pg_get_functiondef emits no grants. proacl is the authoritative ACL; role_routine_grants is the ' +
      'expanded view of the same thing. A `create or replace function` preserves these; a drop/create ' +
      'would silently drop them.',
    overload_count: aclRows[0]?.overload_count ?? 0,
    exactly_one_overload: aclRows.length === 1,
    routines: aclRows,
    role_routine_grants: grantRows,
  };
  const file = `${name}.grants.json`;
  writeFileSync(join(outDir, file), `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  console.log(
    `wrote ${file}  (overloads=${aclRows.length}, acl=${JSON.stringify(aclRows[0]?.proacl ?? null)})`,
  );
}
