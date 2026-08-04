-- LIVE definition dumped from Supabase project kfbgftkjvtynfdwgcgeb
-- captured: 2026-08-04T19:04:17.668Z
-- function: public.admin_deactivate_profile(p_profile_id uuid, p_manager_id uuid, p_reason text)
-- language: plpgsql   security_definer: true   volatility: v
-- READ-ONLY DUMP. Do not apply this file.
CREATE OR REPLACE FUNCTION public.admin_deactivate_profile(p_profile_id uuid, p_manager_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_manager public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_active_managers integer;
  v_active_work integer;
  v_pending integer;
  v_next uuid;
begin
  if p_profile_id is null or p_manager_id is null then
    raise exception 'Manager and user IDs are required';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'A deletion reason is required';
  end if;
  if p_profile_id = p_manager_id then
    raise exception 'A manager cannot delete their own account';
  end if;

  select * into v_manager
  from public.profiles
  where id = p_manager_id
    and role = 'manager'
    and is_active;
  if not found then
    raise exception 'Active manager permission required';
  end if;

  select * into v_target
  from public.profiles
  where id = p_profile_id
    and is_active
  for update;
  if not found then
    raise exception 'Active user not found';
  end if;

  if v_target.role = 'manager' then
    select count(*) into v_active_managers
    from public.profiles
    where role = 'manager' and is_active;
    if v_active_managers <= 1 then
      raise exception 'The final active Manager account cannot be deleted';
    end if;
  end if;

  select count(*) into v_active_work
  from public.work_items
  where assigned_profile_id = p_profile_id
    and status = 'active';
  if v_active_work > 0 then
    raise exception 'Reassign or complete this user''s % active work item(s) before deletion', v_active_work;
  end if;

  select count(*) into v_pending
  from public.pending_pricing_quotes
  where assigned_profile_id = p_profile_id;
  if v_pending > 0 then
    raise exception 'Reassign this user''s % Pending Pricing quote(s) before deletion', v_pending;
  end if;

  update public.profiles
  set is_active = false,
      availability = 'unavailable',
      whatsapp_active = false,
      ringcentral_active = false,
      workload_active = false,
      updated_at = now()
  where id = p_profile_id;

  if exists (select 1 from public.rotation_state where kind = 'whatsapp' and current_profile_id = p_profile_id) then
    v_next := public.next_eligible_profile('whatsapp', v_target.whatsapp_position);
    update public.rotation_state
    set current_profile_id = v_next,
        version = version + 1,
        updated_at = now(),
        updated_by = p_manager_id
    where kind = 'whatsapp';
  end if;

  if exists (select 1 from public.rotation_state where kind = 'ringcentral' and current_profile_id = p_profile_id) then
    v_next := public.next_eligible_profile('ringcentral', v_target.ringcentral_position);
    update public.rotation_state
    set current_profile_id = v_next,
        version = version + 1,
        updated_at = now(),
        updated_by = p_manager_id
    where kind = 'ringcentral';
  end if;

  if exists (select 1 from public.rotation_state where kind = 'workload' and current_profile_id = p_profile_id) then
    v_next := public.next_eligible_profile('workload', v_target.workload_position);
    update public.rotation_state
    set current_profile_id = v_next,
        version = version + 1,
        updated_at = now(),
        updated_by = p_manager_id
    where kind = 'workload';
  end if;

  update public.work_desk_settings
  set customer_service_overflow_enabled = false,
      customer_service_profile_id = null,
      updated_at = now(),
      updated_by = p_manager_id
  where singleton_id = true
    and customer_service_profile_id = p_profile_id;

  insert into public.audit_log(
    actor_profile_id,
    action,
    entity_type,
    entity_id,
    old_value,
    new_value,
    reason
  ) values (
    p_manager_id,
    'user_deleted',
    'profile',
    p_profile_id,
    to_jsonb(v_target),
    jsonb_build_object('is_active', false, 'availability', 'unavailable'),
    btrim(p_reason)
  );
end;
$function$

