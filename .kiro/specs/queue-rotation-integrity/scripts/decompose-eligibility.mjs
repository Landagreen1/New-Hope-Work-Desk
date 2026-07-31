/** READ-ONLY decomposition of the next_eligible_profile WHERE clause. */
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

console.log("=== Predicate-by-predicate for every active agent (whatsapp) ===");
console.log(
  JSON.stringify(
    await q(`
  select display_name,
         is_active                      as c_is_active,
         (role = 'agent')               as c_role_agent,
         role::text                     as role_text,
         (availability = 'available')   as c_available,
         availability::text             as avail_text,
         whatsapp_active                as c_wa_active,
         whatsapp_position              as wa_pos,
         (whatsapp_position > 1)        as c_pos_gt_1,
         (is_active and role='agent' and availability='available'
          and whatsapp_active and whatsapp_position > 1) as passes_all
  from public.profiles
  where is_active
  order by whatsapp_position nulls last;
`),
    null,
    1,
  ),
);

console.log("\n=== Raw replication of the LIVE function body, after_position=1 ===");
console.log(
  JSON.stringify(
    await q(`
  select p.display_name, p.whatsapp_position
  from public.profiles p
  where p.is_active
    and p.role = 'agent'
    and p.availability = 'available'
    and p.whatsapp_active
    and p.whatsapp_position > 1
  order by p.whatsapp_position
  limit 5;
`),
    null,
    1,
  ),
);

console.log("\n=== Does the enum literal comparison work? ===");
console.log(
  JSON.stringify(
    await q(`
  select
    (select count(*) from public.profiles where role = 'agent')              as role_eq_agent,
    (select count(*) from public.profiles where role::text = 'agent')        as role_text_agent,
    (select count(*) from public.profiles where availability = 'available')  as avail_eq,
    (select count(*) from public.profiles where availability::text='available') as avail_text,
    (select count(*) from public.profiles where is_active)                   as active_cnt;
`),
    null,
    1,
  ),
);

console.log("\n=== Direct call vs inline SQL, same inputs ===");
console.log(
  JSON.stringify(
    await q(`
  select
    public.next_eligible_profile('whatsapp'::public.rotation_kind, 1) as fn_result,
    (select p.id from public.profiles p
      where p.is_active and p.role='agent' and p.availability='available'
        and p.whatsapp_active and p.whatsapp_position > 1
      order by p.whatsapp_position limit 1) as inline_result;
`),
    null,
    1,
  ),
);

console.log("\n=== Function owner / RLS posture ===");
console.log(
  JSON.stringify(
    await q(`
  select p.proname, pg_get_userbyid(p.proowner) as fn_owner, p.prosecdef,
         (select pg_get_userbyid(c.relowner) from pg_class c
           where c.relname='profiles' and c.relnamespace='public'::regnamespace) as profiles_owner,
         (select c.relrowsecurity from pg_class c
           where c.relname='profiles' and c.relnamespace='public'::regnamespace) as rls_enabled,
         (select c.relforcerowsecurity from pg_class c
           where c.relname='profiles' and c.relnamespace='public'::regnamespace) as rls_forced,
         current_user as calling_user
  from pg_proc p
  where p.proname='next_eligible_profile' and p.pronamespace='public'::regnamespace;
`),
    null,
    1,
  ),
);
