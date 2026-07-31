-- ============================================================================
-- New Hope Work Desk — Queue Rotation Integrity
-- READ-ONLY production diagnostic
--
-- Safe to run in the Supabase SQL Editor at any time.
-- Contains SELECT statements only: no INSERT/UPDATE/DELETE/DDL, no transaction
-- control, no locking. next_eligible_profile() is STABLE, so calling it in
-- section 6 performs no writes.
--
-- Run top to bottom and keep the output. Sections 5, 6, 7 and 12 are the ones
-- that confirm or rule out the diagnosed defects.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Environment
-- ─────────────────────────────────────────────────────────────────────────────
select
  now()                             as db_now_utc,
  current_setting('TimeZone')       as db_timezone,
  public.current_business_date()    as business_date,
  current_user                      as executing_role;

select * from public.availability_day_state;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Applied migration history
--    NOTE: this project has no supabase_migrations schema. Expect 0 rows or an
--    error; that is itself a finding (migrations were applied out-of-band).
-- ─────────────────────────────────────────────────────────────────────────────
select n.nspname as schema_name
from pg_namespace n
where n.nspname = 'supabase_migrations';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Rotation-related function inventory (signature + body fingerprint)
-- ─────────────────────────────────────────────────────────────────────────────
select
  p.proname                                 as function_name,
  pg_get_function_identity_arguments(p.oid)  as arguments,
  l.lanname                                 as language,
  p.prosecdef                               as security_definer,
  p.provolatile                             as volatility,
  md5(pg_get_functiondef(p.oid))            as body_md5,
  length(pg_get_functiondef(p.oid))         as body_length
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language  l on l.oid = p.prolang
where n.nspname = 'public'
  and p.proname ~ '(rotation|eligible|availability|pass_my_turn|claim|take_quote|quote_take|timed_quote|workload|intake|turn)'
order by p.proname, arguments;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Full source of the rotation engine and every turn-consuming function
--    Compare each body against supabase/migrations/ before diagnosing.
-- ─────────────────────────────────────────────────────────────────────────────
select
  p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as signature,
  pg_get_functiondef(p.oid)                                           as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'next_eligible_profile','set_my_availability','pass_my_turn',
    'ensure_daily_availability_reset','current_business_date','is_agent',
    'claim_whatsapp_quote','claim_whatsapp_quote_v094',
    'claim_ringcentral_quote','claim_ringcentral_quote_v094',
    'claim_linked_workload_turn',
    'claim_unlinked_workload_turn','claim_unlinked_workload_turn_v094',
    'claim_workload_turn','take_quote_turn',
    'start_quote_take_timer','start_quote_take_timer_v094',
    'claim_timed_quote','steal_timed_quote',
    'cs_intake_claim','cs_intake_claim_ringcentral','cs_intake_convert',
    'cs_intake_manager_assign','claim_ringcentral_intake',
    'assign_customer_intake',
    'manager_set_rotation_eligibility','manager_set_rotation_current',
    'log_manual_quote','log_manual_quote_v094','log_manual_workload',
    'log_payment_v094','manager_create_and_assign_quote_v094'
  )
order by p.proname;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. THE KEY CHECK — does next_eligible_profile still have wraparound?
--
-- CORRECT (repo): the position comparison appears in ORDER BY as a
--                 "case when ... then 0 else 1 end" bucket.
-- BROKEN  (live): the position comparison appears in WHERE as an AND predicate.
-- ─────────────────────────────────────────────────────────────────────────────
select
  case
    when def ~* 'order by\s+case\s+when.*>\s*p_after_position'
      then 'OK — wraparound implemented as an ORDER BY bucket'
    when def ~* 'and\s+case[\s\S]*>\s*p_after_position[\s\S]*order by'
      then 'BROKEN (RC-1) — position filter sits in WHERE, so wraparound is lost'
    else 'UNKNOWN — inspect the body manually in section 4'
  end                                                as wraparound_verdict,
  (def ~* 'position\s+is\s+not\s+null')              as guards_null_position,
  (def ~* 'role\s*=\s*''agent''')                    as restricts_to_role_agent,
  def                                                as full_definition
from (
  select pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'next_eligible_profile'
) s;


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Behavioural probe of the selector (STABLE — no writes)
--    Any <<NULL>> in a row where "eligible agents" > 0 is a defect.
-- ─────────────────────────────────────────────────────────────────────────────
with kinds as (
  select unnest(enum_range(null::public.rotation_kind)) as kind
),
positions as (select generate_series(1, 20) as p),
eligible_counts as (
  select k.kind,
         count(*) filter (
           where pr.is_active
             and pr.availability::text = 'available'
             and case k.kind::text
                   when 'whatsapp'    then pr.whatsapp_active
                   when 'ringcentral' then pr.ringcentral_active
                   else                    pr.workload_active
                 end
             and case k.kind::text
                   when 'whatsapp'    then pr.whatsapp_position
                   when 'ringcentral' then pr.ringcentral_position
                   else                    pr.workload_position
                 end is not null
         ) as eligible_agents
  from kinds k cross join public.profiles pr
  group by k.kind
)
select
  k.kind::text                                     as rotation,
  ec.eligible_agents,
  po.p                                             as after_position,
  coalesce(np.display_name, '<<NULL>>')            as selector_returns,
  case
    when ec.eligible_agents > 0 and np.id is null
      then 'DEFECT: eligible agents exist but selector returned NULL'
    else 'ok'
  end                                              as verdict
from kinds k
join eligible_counts ec on ec.kind = k.kind
cross join positions po
left join public.profiles np
       on np.id = public.next_eligible_profile(k.kind, po.p)
order by k.kind, po.p;

-- Same probe with a NULL after_position (current agent has no position).
select
  k.kind::text                          as rotation,
  coalesce(np.display_name, '<<NULL>>') as selector_returns_for_null_position
from (select unnest(enum_range(null::public.rotation_kind)) as kind) k
left join public.profiles np
       on np.id = public.next_eligible_profile(k.kind, null)
order by 1;


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. INVARIANT AUDIT — current rotation state vs eligibility
-- ─────────────────────────────────────────────────────────────────────────────
with eligible as (
  select r.kind,
         count(p.id) filter (
           where p.is_active
             and p.availability::text = 'available'
             and case r.kind::text
                   when 'whatsapp'    then p.whatsapp_active
                   when 'ringcentral' then p.ringcentral_active
                   else                    p.workload_active
                 end
             and case r.kind::text
                   when 'whatsapp'    then p.whatsapp_position
                   when 'ringcentral' then p.ringcentral_position
                   else                    p.workload_position
                 end is not null
         ) as eligible_count
  from public.rotation_state r
  cross join public.profiles p
  group by r.kind
)
select
  r.kind::text            as rotation,
  r.current_profile_id,
  cp.display_name         as current_agent,
  cp.role::text           as current_role,
  cp.is_active            as current_is_active,
  cp.availability::text   as current_availability,
  case r.kind::text
    when 'whatsapp'    then cp.whatsapp_active
    when 'ringcentral' then cp.ringcentral_active
    else                    cp.workload_active
  end                     as current_rotation_enabled,
  case r.kind::text
    when 'whatsapp'    then cp.whatsapp_position
    when 'ringcentral' then cp.ringcentral_position
    else                    cp.workload_position
  end                     as current_position,
  e.eligible_count,
  r.version,
  r.updated_at,
  ub.display_name         as updated_by,
  case
    when r.current_profile_id is null and e.eligible_count > 0
      then 'VIOLATION (inv 3/7): NULL current agent while eligible agents exist'
    when r.current_profile_id is null and e.eligible_count = 0
      then 'OK (inv 6): legitimately empty — no eligible agents'
    when cp.id is null
      then 'VIOLATION (inv 4): current_profile_id points at a missing profile'
    when not cp.is_active
      then 'VIOLATION (inv 4/5): current agent is inactive'
    when cp.availability::text <> 'available'
      then 'VIOLATION (inv 4/5): current agent is not available'
    when not case r.kind::text
                when 'whatsapp'    then cp.whatsapp_active
                when 'ringcentral' then cp.ringcentral_active
                else                    cp.workload_active
              end
      then 'VIOLATION (inv 4/5): current agent is disabled for this rotation'
    when case r.kind::text
           when 'whatsapp'    then cp.whatsapp_position
           when 'ringcentral' then cp.ringcentral_position
           else                    cp.workload_position
         end is null
      then 'VIOLATION (inv 4): current agent has no rotation position'
    else 'OK'
  end                     as verdict
from public.rotation_state r
left join public.profiles cp on cp.id = r.current_profile_id
left join public.profiles ub on ub.id = r.updated_by
join eligible e on e.kind = r.kind
order by r.kind;


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Roster: availability, per-rotation eligibility and positions
-- ─────────────────────────────────────────────────────────────────────────────
select
  p.display_name,
  p.role::text            as role,
  p.is_active,
  p.availability::text    as availability,
  p.whatsapp_active       as wa_enabled,
  p.whatsapp_position     as wa_position,
  p.ringcentral_active    as rc_enabled,
  p.ringcentral_position  as rc_position,
  p.workload_active       as wl_enabled,
  p.workload_position     as wl_position,
  (p.is_active and p.availability::text = 'available'
     and p.whatsapp_active    and p.whatsapp_position    is not null) as eligible_whatsapp,
  (p.is_active and p.availability::text = 'available'
     and p.ringcentral_active and p.ringcentral_position is not null) as eligible_ringcentral,
  (p.is_active and p.availability::text = 'available'
     and p.workload_active    and p.workload_position    is not null) as eligible_workload
from public.profiles p
where p.is_active
  and p.role::text in ('agent','sales_supervisor','manager','super_admin')
order by p.whatsapp_position nulls last, p.display_name;


-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Position hygiene: duplicates and NULLs among rotation-enabled agents
-- ─────────────────────────────────────────────────────────────────────────────
select 'whatsapp' as rotation, whatsapp_position as position,
       count(*) as agents, string_agg(display_name, ', ' order by display_name) as who,
       case when whatsapp_position is null then 'NULL position (inv 4)'
            else 'duplicate position (non-deterministic order)' end as issue
from public.profiles
where is_active and whatsapp_active
group by whatsapp_position
having count(*) > 1 or whatsapp_position is null
union all
select 'ringcentral', ringcentral_position, count(*),
       string_agg(display_name, ', ' order by display_name),
       case when ringcentral_position is null then 'NULL position (inv 4)'
            else 'duplicate position (non-deterministic order)' end
from public.profiles
where is_active and ringcentral_active
group by ringcentral_position
having count(*) > 1 or ringcentral_position is null
union all
select 'workload', workload_position, count(*),
       string_agg(display_name, ', ' order by display_name),
       case when workload_position is null then 'NULL position (inv 4)'
            else 'duplicate position (non-deterministic order)' end
from public.profiles
where is_active and workload_active
group by workload_position
having count(*) > 1 or workload_position is null
order by 1, 2;

-- Gaps in the position sequence per rotation.
select 'whatsapp' as rotation, g.n as missing_position
from generate_series(
       (select min(whatsapp_position) from public.profiles where is_active and whatsapp_active),
       (select max(whatsapp_position) from public.profiles where is_active and whatsapp_active)
     ) g(n)
where not exists (
  select 1 from public.profiles
  where is_active and whatsapp_active and whatsapp_position = g.n
)
order by 1, 2;


-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Recent turn events
-- ─────────────────────────────────────────────────────────────────────────────
select
  t.created_at,
  t.rotation::text          as rotation,
  t.action::text            as action,
  a.display_name            as actor,
  pv.display_name           as previous_agent,
  nx.display_name           as next_agent,
  (t.next_profile_id is null)                     as advanced_to_null,
  (t.previous_profile_id = t.next_profile_id)     as stuck_on_same_agent,
  t.work_item_id,
  t.reason
from public.turn_events t
left join public.profiles a  on a.id  = t.actor_profile_id
left join public.profiles pv on pv.id = t.previous_profile_id
left join public.profiles nx on nx.id = t.next_profile_id
order by t.created_at desc
limit 150;


-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Transitions that nulled a rotation, and transitions that stuck on self
--     "stuck_on_same_agent" is the RC-1 + v1.8.5 coalesce signature.
-- ─────────────────────────────────────────────────────────────────────────────
select
  date_trunc('day', t.created_at)          as day,
  t.rotation::text                         as rotation,
  t.action::text                           as action,
  count(*) filter (where t.next_profile_id is null)                  as went_null,
  count(*) filter (where t.previous_profile_id = t.next_profile_id)  as stuck_on_self,
  count(*)                                                          as total
from public.turn_events t
where t.created_at > now() - interval '30 days'
group by 1, 2, 3
having count(*) filter (where t.next_profile_id is null) > 0
    or count(*) filter (where t.previous_profile_id = t.next_profile_id) > 0
order by 1 desc, 2, 3;

-- How often did managers manually repair a rotation?
select
  date_trunc('day', created_at) as day,
  rotation::text                as rotation,
  count(*)                      as manual_repairs
from public.turn_events
where action::text = 'manual_change'
  and created_at > now() - interval '30 days'
group by 1, 2
order by 1 desc, 2;


-- ─────────────────────────────────────────────────────────────────────────────
-- 12. Atomicity audit
-- ─────────────────────────────────────────────────────────────────────────────

-- 12a. More than one turn_events row for the same work item (double advance).
select work_item_id, rotation::text as rotation, count(*) as turn_events_rows,
       min(created_at) as first_at, max(created_at) as last_at
from public.turn_events
where work_item_id is not null
group by work_item_id, rotation
having count(*) > 1
order by max(created_at) desc
limit 50;

-- 12b. Turn-assigned work items with NO turn_events row (quote without a turn).
select w.id, w.customer_name, w.assignment_method, w.assigned_profile_id,
       w.created_at
from public.work_items w
where w.assignment_method::text in ('whatsapp_turn','ringcentral_turn','workload_turn')
  and not exists (select 1 from public.turn_events t where t.work_item_id = w.id)
order by w.created_at desc
limit 50;


-- ─────────────────────────────────────────────────────────────────────────────
-- 13. Customer Service intake health — both parallel systems
-- ─────────────────────────────────────────────────────────────────────────────

-- 13a. Which intake tables exist?
select c.relname as table_name,
       (select count(*) from pg_attribute a
         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and (c.relname like '%intake%' or c.relname like '%rotation%'
       or c.relname like '%turn%' or c.relname like '%quote_take%')
order by c.relname;

-- 13b. cs_intake_submissions: claimed but never converted (stuck mid-flow).
select id, status::text as status, intake_channel, claimed_by, claimed_at,
       work_item_id, submitted_at, line_of_business::text as lob
from public.cs_intake_submissions
where status::text = 'claimed' and work_item_id is null
order by claimed_at desc nulls last
limit 50;

-- 13c. RingCentral intake claims that did NOT advance the RingCentral turn.
--      Any rows here confirm RC-4.
select e.submission_id, e.created_at, e.event_type, e.actor_id,
       'no matching ringcentral turn_events row within 5s' as finding
from public.cs_intake_events e
where e.event_type in ('ringcentral_claimed','ringcentral_claim_recovered')
  and not exists (
    select 1 from public.turn_events t
    where t.rotation::text = 'ringcentral'
      and t.actor_profile_id = e.actor_id
      and t.created_at between e.created_at - interval '5 seconds'
                           and e.created_at + interval '5 seconds'
  )
order by e.created_at desc
limit 50;


-- ─────────────────────────────────────────────────────────────────────────────
-- 14. Rescue / timed quote state
-- ─────────────────────────────────────────────────────────────────────────────
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'quote_take_timers'
order by ordinal_position;

select
  t.id,
  t.rotation::text        as rotation,
  t.status,
  cur.display_name        as current_agent,
  sb.display_name         as started_by,
  cb.display_name         as claimed_by,
  t.received_at,
  t.started_at,
  t.deadline_at,
  t.warning_sent_at,
  t.completed_at,
  t.source_work_item_id,
  (t.deadline_at < now() and t.status = 'active') as expired_but_still_active
from public.quote_take_timers t
left join public.profiles cur on cur.id = t.current_profile_id
left join public.profiles sb  on sb.id  = t.started_by_profile_id
left join public.profiles cb  on cb.id  = t.claimed_by_profile_id
order by t.started_at desc nulls last
limit 25;


-- ─────────────────────────────────────────────────────────────────────────────
-- 15. Realtime publication membership
--     rotation_state, profiles, turn_events and work_items must be present for
--     the UI to receive push updates.
-- ─────────────────────────────────────────────────────────────────────────────
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;


-- ─────────────────────────────────────────────────────────────────────────────
-- 16. Daily rotation start bookkeeping
-- ─────────────────────────────────────────────────────────────────────────────
select d.business_date, d.rotation::text as rotation, pr.display_name as starter
from public.daily_rotation_starts d
left join public.profiles pr on pr.id = d.starter_profile_id
order by d.business_date desc, d.rotation
limit 40;


-- ─────────────────────────────────────────────────────────────────────────────
-- 17. Manager eligibility changes (does a restore leave the rotation NULL?)
-- ─────────────────────────────────────────────────────────────────────────────
select a.created_at,
       act.display_name as actor,
       tgt.display_name as target,
       (a.old_value->>'whatsapp_active')    as old_wa,
       (a.new_value->>'whatsapp_active')    as new_wa,
       (a.old_value->>'ringcentral_active') as old_rc,
       (a.new_value->>'ringcentral_active') as new_rc,
       (a.old_value->>'workload_active')    as old_wl,
       (a.new_value->>'workload_active')    as new_wl,
       a.reason
from public.audit_log a
left join public.profiles act on act.id = a.actor_profile_id
left join public.profiles tgt on tgt.id = a.entity_id
where a.action = 'rotation_eligibility_changed'
order by a.created_at desc
limit 60;

-- ============================================================================
-- End of diagnostic. Nothing above modifies data.
-- ============================================================================
