CREATE OR REPLACE FUNCTION public.pass_my_turn(p_rotation rotation_kind, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me public.profiles%rowtype;
  v_state public.rotation_state%rowtype;
  v_next uuid;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if p_rotation = 'workload' then
    raise exception 'Additional Workload turns cannot be passed. Take the task and use Customer Service overflow after acceptance when needed.';
  end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A pass reason is required'; end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;

  select * into v_state from public.rotation_state where kind = p_rotation for update;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This turn belongs to another agent'; end if;

  v_next := public.next_eligible_profile(
    p_rotation,
    case when p_rotation = 'whatsapp' then v_me.whatsapp_position else v_me.ringcentral_position end
  );
  if v_next is null then raise exception 'No eligible next agent'; end if;

  update public.rotation_state
  set current_profile_id = v_next,
      version = version + 1,
      updated_at = now(),
      updated_by = v_me.id
  where kind = p_rotation;

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
  values (p_rotation, 'pass', v_me.id, v_me.id, v_next, btrim(p_reason));

  return v_next;
end;
$function$

