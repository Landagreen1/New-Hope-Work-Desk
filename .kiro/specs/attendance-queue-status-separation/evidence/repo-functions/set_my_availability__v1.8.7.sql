-- REPO definition extracted from supabase/migrations/v1.8.7-fix-rotation-integrity.sql line 525
-- for comparison against the live dump in ../live-functions/set_my_availability.sql

create or replace function public.set_my_availability(p_status public.availability_status)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me            public.profiles%rowtype;
  v_rotation      public.rotation_state%rowtype;
  v_eligible      boolean;
  v_started_today boolean;
  v_current       uuid;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;

  update public.profiles set availability = p_status where id = v_me.id;

  -- Deterministic lock order across all three rotations.
  for v_rotation in select * from public.rotation_state order by kind for update loop

    v_eligible := case
      when v_rotation.kind = 'whatsapp'    then v_me.whatsapp_active
      when v_rotation.kind = 'ringcentral' then v_me.ringcentral_active
      else                                      v_me.workload_active
    end;

    if p_status = 'available' then
      if v_eligible then
        -- Repair a stale or empty pointer first.
        perform public.ensure_rotation_valid(v_rotation.kind, v_me.id);

        select current_profile_id into v_current
        from public.rotation_state where kind = v_rotation.kind;

        -- Still empty and this agent is eligible: they start the queue.
        if v_current is null
           and public.is_rotation_eligible(v_me.id, v_rotation.kind) then

          select exists (
            select 1 from public.daily_rotation_starts d
            where d.business_date = public.current_business_date()
              and d.rotation = v_rotation.kind
          ) into v_started_today;

          if not v_started_today then
            insert into public.daily_rotation_starts(business_date, rotation, starter_profile_id)
            values (public.current_business_date(), v_rotation.kind, v_me.id)
            on conflict (business_date, rotation) do nothing;
          end if;

          update public.rotation_state
          set current_profile_id = v_me.id,
              version            = version + 1,
              updated_at         = now(),
              updated_by         = v_me.id
          where kind = v_rotation.kind;

          insert into public.turn_events(
            rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason
          ) values (
            v_rotation.kind,
            case when v_started_today then 'auto_skip' else 'daily_start' end,
            v_me.id, null, v_me.id,
            case
              when v_started_today
                then 'Empty queue resumed when an eligible agent became available'
              else 'First eligible agent available for the business day'
            end
          );
        end if;
      end if;

    else
      -- Going unavailable / on break: hand off only the rotations this agent holds.
      if v_rotation.current_profile_id = v_me.id then
        perform public.advance_rotation(
          p_rotation       => v_rotation.kind,
          p_actor          => v_me.id,
          p_after_position => public.rotation_position_of(v_me.id, v_rotation.kind),
          p_action         => 'auto_skip',
          p_previous       => v_me.id,
          p_fallback       => null,   -- the actor is no longer eligible
          p_work_item_id   => null,
          p_reason         => 'Agent became unavailable'
        );
      end if;
    end if;
  end loop;
end;
$$;
