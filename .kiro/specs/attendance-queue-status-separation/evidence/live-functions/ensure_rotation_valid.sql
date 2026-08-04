-- LIVE definition dumped from Supabase project kfbgftkjvtynfdwgcgeb
-- captured: 2026-08-04T19:04:17.670Z
-- function: public.ensure_rotation_valid(p_rotation rotation_kind, p_actor uuid)
-- language: plpgsql   security_definer: true   volatility: v
-- READ-ONLY DUMP. Do not apply this file.
CREATE OR REPLACE FUNCTION public.ensure_rotation_valid(p_rotation rotation_kind, p_actor uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_current  uuid;
  v_next     uuid;
  v_from_pos integer;
begin
  select current_profile_id into v_current
  from public.rotation_state
  where kind = p_rotation;

  -- Already valid: do nothing at all.
  if v_current is not null and public.is_rotation_eligible(v_current, p_rotation) then
    return v_current;
  end if;

  -- Resume from the stale agent's position when known, so the queue keeps its
  -- place rather than restarting at the lowest position.
  if v_current is not null then
    v_from_pos := public.rotation_position_of(v_current, p_rotation);
  end if;

  v_next := public.next_eligible_profile(p_rotation, v_from_pos);

  if v_next is null then
    -- No eligible agents. NULL is legitimate (invariant 6). Only record a
    -- transition if we are actually changing the stored value.
    if v_current is null then
      return null;
    end if;

    update public.rotation_state
    set current_profile_id = null,
        version            = version + 1,
        updated_at         = now(),
        updated_by         = p_actor
    where kind = p_rotation;

    insert into public.turn_events(
      rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason
    ) values (
      p_rotation, 'auto_skip', p_actor, v_current, null,
      'Current agent was no longer eligible. ' || public.rotation_empty_reason(p_rotation)
    );
    return null;
  end if;

  if v_next = v_current then
    return v_current;
  end if;

  update public.rotation_state
  set current_profile_id = v_next,
      version            = version + 1,
      updated_at         = now(),
      updated_by         = p_actor
  where kind = p_rotation;

  insert into public.turn_events(
    rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason
  ) values (
    p_rotation, 'auto_skip', p_actor, v_current, v_next,
    case
      when v_current is null
        then 'Empty queue recovered automatically because an eligible agent was available'
      else 'Current agent was no longer eligible; queue advanced automatically'
    end
  );

  return v_next;
end;
$function$

