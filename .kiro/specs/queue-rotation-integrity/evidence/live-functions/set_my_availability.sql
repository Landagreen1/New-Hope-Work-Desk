CREATE OR REPLACE FUNCTION public.set_my_availability(p_status availability_status)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me public.profiles%rowtype;
  v_rotation public.rotation_state%rowtype;
  v_next uuid;
  v_previous uuid;
  v_eligible boolean;
  v_current_usable boolean;
  v_started_today boolean;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me
  from public.profiles
  where id = auth.uid() and is_active
  for update;

  if not found then raise exception 'Active profile not found'; end if;

  update public.profiles
  set availability = p_status
  where id = v_me.id;

  if p_status = 'available' then
    for v_rotation in select * from public.rotation_state order by kind for update loop
      v_eligible := case
        when v_rotation.kind = 'whatsapp' then v_me.whatsapp_active
        when v_rotation.kind = 'ringcentral' then v_me.ringcentral_active
        else v_me.workload_active
      end;

      if v_eligible then
        if v_rotation.current_profile_id is null then
          select exists (
            select 1
            from public.daily_rotation_starts d
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
              version = version + 1,
              updated_at = now(),
              updated_by = v_me.id
          where kind = v_rotation.kind;

          insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
          values (
            v_rotation.kind,
            case when v_started_today then 'auto_skip' else 'daily_start' end,
            v_me.id,
            null,
            v_me.id,
            case when v_started_today then 'Empty queue resumed when an eligible agent became available' else 'First eligible agent available for the business day' end
          );
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

          if not v_current_usable then
            v_previous := v_rotation.current_profile_id;

            update public.rotation_state
            set current_profile_id = v_me.id,
                version = version + 1,
                updated_at = now(),
                updated_by = v_me.id
            where kind = v_rotation.kind;

            insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
            values (v_rotation.kind, 'auto_skip', v_me.id, v_previous, v_me.id, 'Stale queue corrected when an eligible agent became available');
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

        update public.rotation_state
        set current_profile_id = v_next,
            version = version + 1,
            updated_at = now(),
            updated_by = v_me.id
        where kind = v_rotation.kind;

        insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
        values (
          v_rotation.kind,
          'auto_skip',
          v_me.id,
          v_me.id,
          v_next,
          case when v_next is null then 'Agent became unavailable and no eligible agent is currently available' else 'Agent became unavailable' end
        );
      end if;
    end loop;
  end if;
end;
$function$

