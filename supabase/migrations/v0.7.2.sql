-- New Hope Work Desk v0.7.2 migration
-- Manager-selected temporary passwords are an application/API change.
-- This database change resets every active agent to Unavailable at each new
-- America/New_York business date so the first eligible agent to click Available
-- starts the day's rotations.
-- Run once after v0.7.0 has been applied successfully.

begin;

-- Singleton state used to make the daily reset concurrency-safe and idempotent.
create table if not exists public.availability_day_state (
  singleton_key boolean primary key default true check (singleton_key),
  business_date date not null,
  reset_at timestamptz not null default now()
);

insert into public.availability_day_state(singleton_key, business_date, reset_at)
values (true, public.current_business_date(), now())
on conflict (singleton_key) do nothing;

alter table public.availability_day_state enable row level security;
revoke all on table public.availability_day_state from anon, authenticated;

-- Returns true only when this call performs the first reset for a new business day.
-- The advisory transaction lock protects against agents in two offices opening
-- the Work Desk at the same time around midnight.
create or replace function public.ensure_daily_availability_reset()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.current_business_date();
  v_last_business_date date;
begin
  perform pg_advisory_xact_lock(707200072);

  insert into public.availability_day_state(singleton_key, business_date, reset_at)
  values (true, v_today, now())
  on conflict (singleton_key) do nothing;

  select business_date
  into v_last_business_date
  from public.availability_day_state
  where singleton_key = true
  for update;

  if v_last_business_date < v_today then
    update public.profiles
    set availability = 'unavailable'
    where role = 'agent'
      and is_active
      and availability <> 'unavailable';

    update public.availability_day_state
    set business_date = v_today,
        reset_at = now()
    where singleton_key = true;

    return true;
  end if;

  return false;
end;
$$;

-- Reinstall availability changes with the daily reset guard.
create or replace function public.set_my_availability(p_status public.availability_status)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles%rowtype;
  v_rotation public.rotation_state%rowtype;
  v_next uuid;
  v_start_id uuid;
  v_previous uuid;
  v_eligible boolean;
  v_current_usable boolean;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;

  -- Self-healing daily reset: before any status change, make sure a new Eastern
  -- business day starts with every active agent marked Unavailable.
  perform public.ensure_daily_availability_reset();
  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;

  update public.profiles set availability = p_status where id = v_me.id;

  -- The first eligible agent to become Available each business day starts that queue.
  -- Normally the same person starts all three queues. Queue-specific pauses are respected.
  if p_status = 'available' then
    for v_rotation in select * from public.rotation_state order by kind for update loop
      v_eligible := case
        when v_rotation.kind = 'whatsapp' then v_me.whatsapp_active
        when v_rotation.kind = 'ringcentral' then v_me.ringcentral_active
        else v_me.workload_active
      end;

      if v_eligible then
        v_start_id := null;
        insert into public.daily_rotation_starts(business_date, rotation, starter_profile_id)
        values (public.current_business_date(), v_rotation.kind, v_me.id)
        on conflict (business_date, rotation) do nothing
        returning starter_profile_id into v_start_id;

        if v_start_id is not null then
          v_previous := v_rotation.current_profile_id;
          update public.rotation_state
          set current_profile_id = v_me.id,
              version = version + 1,
              updated_at = now(),
              updated_by = v_me.id
          where kind = v_rotation.kind;

          insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
          values (v_rotation.kind, 'daily_start', v_me.id, v_previous, v_me.id, 'First eligible agent available for the business day');
        else
          select exists (
            select 1 from public.profiles p
            where p.id = v_rotation.current_profile_id
              and p.is_active
              and p.role = 'agent'
              and p.availability = 'available'
              and case
                when v_rotation.kind = 'whatsapp' then p.whatsapp_active
                when v_rotation.kind = 'ringcentral' then p.ringcentral_active
                else p.workload_active
              end
          ) into v_current_usable;

          -- If a queue was left pointing at an unavailable agent because nobody else
          -- was available at the time, the first eligible returning agent resumes it.
          if not v_current_usable then
            v_previous := v_rotation.current_profile_id;
            update public.rotation_state
            set current_profile_id = v_me.id,
                version = version + 1,
                updated_at = now(),
                updated_by = v_me.id
            where kind = v_rotation.kind;

            insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
            values (v_rotation.kind, 'auto_skip', v_me.id, v_previous, v_me.id, 'Queue resumed when an eligible agent became available');
          end if;
        end if;
      end if;
    end loop;
  else
    for v_rotation in select * from public.rotation_state order by kind for update loop
      if v_rotation.current_profile_id = v_me.id then
        v_next := public.next_eligible_profile(
          v_rotation.kind,
          case
            when v_rotation.kind = 'whatsapp' then v_me.whatsapp_position
            when v_rotation.kind = 'ringcentral' then v_me.ringcentral_position
            else v_me.workload_position
          end
        );
        if v_next is not null and v_next <> v_me.id then
          update public.rotation_state
          set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = v_me.id
          where kind = v_rotation.kind;

          insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
          values (v_rotation.kind, 'auto_skip', v_me.id, v_me.id, v_next, 'Agent became unavailable');
        end if;
      end if;
    end loop;
  end if;
end;
$$;

revoke execute on function public.ensure_daily_availability_reset() from public, anon;
grant execute on function public.ensure_daily_availability_reset() to authenticated;
grant execute on function public.set_my_availability(public.availability_status) to authenticated;

insert into public.audit_log(actor_profile_id, action, entity_type, new_value, reason)
values (auth.uid(), 'migration_v0_7_2_applied', 'system', jsonb_build_object('version', '0.7.2'), 'Daily availability reset and manager-selected temporary password support');

commit;
