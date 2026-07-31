CREATE OR REPLACE FUNCTION public.claim_workload_turn(p_customer_name text, p_dealer_id uuid, p_work_type work_type, p_original_owner_profile_id uuid DEFAULT NULL::uuid, p_change_type text DEFAULT NULL::text)
 RETURNS work_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me public.profiles%rowtype;
  v_state public.rotation_state%rowtype;
  v_next uuid;
  v_item public.work_items%rowtype;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if p_work_type not in ('activation', 'change') then raise exception 'Additional Workload only accepts activations or changes'; end if;

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;
  if v_me.availability <> 'available' or not v_me.workload_active then raise exception 'You are not eligible for the Additional Workload rotation'; end if;

  select * into v_state from public.rotation_state where kind = 'workload' for update;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This Additional Workload turn belongs to another agent'; end if;

  insert into public.work_items(customer_name, dealer_id, work_type, original_owner_profile_id, assigned_profile_id, assignment_method, status, change_type, received_through, created_by, accepted_at)
  values (trim(p_customer_name), p_dealer_id, p_work_type, p_original_owner_profile_id, v_me.id, 'workload_turn', 'active', p_change_type, 'Manager routed', v_me.id, now())
  returning * into v_item;

  v_next := public.next_eligible_profile('workload', v_me.workload_position);
  if v_next is null then raise exception 'No eligible next agent'; end if;

  update public.rotation_state
  set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = v_me.id
  where kind = 'workload';

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id)
  values ('workload', 'claim', v_me.id, v_me.id, v_next, v_item.id);

  return v_item;
end;
$function$

