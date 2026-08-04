-- LIVE definition dumped from Supabase project kfbgftkjvtynfdwgcgeb
-- captured: 2026-08-04T19:04:17.669Z
-- function: public.advance_rotation(p_rotation rotation_kind, p_actor uuid, p_after_position integer, p_action text, p_previous uuid, p_fallback uuid, p_work_item_id uuid, p_reason text)
-- language: plpgsql   security_definer: true   volatility: v
-- READ-ONLY DUMP. Do not apply this file.
CREATE OR REPLACE FUNCTION public.advance_rotation(p_rotation rotation_kind, p_actor uuid, p_after_position integer, p_action text, p_previous uuid DEFAULT NULL::uuid, p_fallback uuid DEFAULT NULL::uuid, p_work_item_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_next     uuid;
  v_previous uuid;
  v_reason   text := p_reason;
begin
  if p_action not in ('claim', 'pass', 'manual_change', 'auto_skip', 'daily_start') then
    raise exception 'Invalid turn action: %', p_action;
  end if;

  select current_profile_id into v_previous
  from public.rotation_state
  where kind = p_rotation;

  if p_previous is not null then
    v_previous := p_previous;
  end if;

  v_next := public.next_eligible_profile(p_rotation, p_after_position);

  -- Invariant 10 / invariant 3: never null out a live queue. Prefer the caller's
  -- explicit fallback, then the actor, provided they are still eligible.
  if v_next is null then
    if p_fallback is not null and public.is_rotation_eligible(p_fallback, p_rotation) then
      v_next := p_fallback;
    elsif p_actor is not null and public.is_rotation_eligible(p_actor, p_rotation) then
      v_next := p_actor;
    end if;
  end if;

  -- Invariant 6: with genuinely no eligible agents, NULL is correct — but say why.
  if v_next is null then
    v_reason := coalesce(v_reason || ' — ', '') || public.rotation_empty_reason(p_rotation);
  end if;

  update public.rotation_state
  set current_profile_id = v_next,
      version            = version + 1,
      updated_at         = now(),
      updated_by         = p_actor
  where kind = p_rotation;

  insert into public.turn_events(
    rotation, action, actor_profile_id, previous_profile_id,
    next_profile_id, work_item_id, reason
  ) values (
    p_rotation, p_action, p_actor, v_previous, v_next, p_work_item_id, v_reason
  );

  return v_next;
end;
$function$

