-- LIVE definition dumped from Supabase project kfbgftkjvtynfdwgcgeb
-- captured: 2026-08-04T19:04:17.671Z
-- function: public.manager_set_rotation_eligibility(p_profile_id uuid, p_rotation rotation_kind, p_active boolean, p_reason text)
-- language: plpgsql   security_definer: true   volatility: v
-- READ-ONLY DUMP. Do not apply this file.
CREATE OR REPLACE FUNCTION public.manager_set_rotation_eligibility(p_profile_id uuid, p_rotation rotation_kind, p_active boolean, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_old     jsonb;
  v_profile public.profiles%rowtype;
begin
  if not public.can_manage_sales() then raise exception 'Manager permission required'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required'; end if;

  select * into v_profile from public.profiles where id = p_profile_id for update;
  if not found or v_profile.role <> 'agent' then
    raise exception 'Active agent not found';
  end if;

  v_old := to_jsonb(v_profile);

  if p_rotation = 'whatsapp' then
    update public.profiles set whatsapp_active = p_active where id = p_profile_id;
  elsif p_rotation = 'ringcentral' then
    update public.profiles set ringcentral_active = p_active where id = p_profile_id;
  else
    update public.profiles set workload_active = p_active where id = p_profile_id;
  end if;

  -- Lock the affected rotation, then repair it. Runs whether we removed or
  -- restored the agent, and touches no other rotation.
  perform 1 from public.rotation_state where kind = p_rotation for update;
  perform public.ensure_rotation_valid(p_rotation, auth.uid());

  insert into public.audit_log(
    actor_profile_id, action, entity_type, entity_id, old_value, new_value, reason
  )
  select auth.uid(), 'rotation_eligibility_changed', 'profile', p_profile_id,
         v_old, to_jsonb(p), p_reason
  from public.profiles p where p.id = p_profile_id;
end;
$function$

