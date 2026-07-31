CREATE OR REPLACE FUNCTION public.claim_linked_workload_turn(p_related_quote_source_work_item_id uuid, p_work_type work_type, p_change_type text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
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
  v_customer_name text;
  v_dealer_id uuid;
  v_quote_owner_id uuid;
  v_quote_assigned_id uuid;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if p_work_type not in ('activation', 'change') then raise exception 'Additional Workload only accepts activations or changes'; end if;
  if p_related_quote_source_work_item_id is null then raise exception 'Select the existing quote this workload belongs to'; end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;
  if v_me.availability <> 'available' or not v_me.workload_active then raise exception 'Set your status to Available before taking Additional Workload'; end if;

  select q.customer_name, q.dealer_id, q.original_owner_profile_id, q.assigned_profile_id
  into v_customer_name, v_dealer_id, v_quote_owner_id, v_quote_assigned_id
  from (
    select w.customer_name, w.dealer_id, w.original_owner_profile_id, w.assigned_profile_id, w.created_at as stage_at
    from public.work_items w
    where w.id = p_related_quote_source_work_item_id
      and w.work_type in ('new_quote', 'requote')
    union all
    select p.customer_name, p.dealer_id, p.original_owner_profile_id, p.assigned_profile_id, p.price_sent_at
    from public.pending_pricing_quotes p
    where p.source_work_item_id = p_related_quote_source_work_item_id
    union all
    select o.customer_name, o.dealer_id, o.original_owner_profile_id, o.assigned_profile_id, o.finalized_at
    from public.quote_outcomes o
    where o.source_work_item_id = p_related_quote_source_work_item_id
  ) q
  order by q.stage_at desc
  limit 1;

  if v_customer_name is null then raise exception 'The selected quote no longer exists'; end if;

  select * into v_state from public.rotation_state where kind = 'workload' for update;
  if not found then raise exception 'Additional Workload queue is not initialized'; end if;
  if v_state.current_profile_id is null then raise exception 'No agent has started the Additional Workload queue today. Click Available to start it'; end if;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This Additional Workload turn belongs to another agent'; end if;

  insert into public.work_items(
    customer_name, dealer_id, work_type, original_owner_profile_id,
    assigned_profile_id, assignment_method, status, change_type, note,
    received_through, created_by, accepted_at, related_quote_source_work_item_id
  ) values (
    v_customer_name, v_dealer_id, p_work_type, coalesce(v_quote_owner_id, v_quote_assigned_id),
    v_me.id, 'workload_turn', 'active', nullif(btrim(p_change_type), ''), nullif(btrim(p_note), ''),
    'Linked quote', v_me.id, now(), p_related_quote_source_work_item_id
  ) returning * into v_item;

  insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at)
  values (
    p_related_quote_source_work_item_id,
    case when p_work_type = 'activation' then 'activation' else 'change' end,
    v_me.id,
    coalesce(v_quote_assigned_id, v_me.id),
    jsonb_build_object('service_work_item_id', v_item.id, 'change_type', nullif(btrim(p_change_type), ''), 'note', nullif(btrim(p_note), '')),
    now()
  );

  perform public.add_quote_note_if_present(p_related_quote_source_work_item_id, v_me.id, p_note);

  if p_work_type = 'activation' then
    perform public.finalize_quote_as_sold_from_activation(p_related_quote_source_work_item_id, v_me.id);
  end if;

  v_next := public.next_eligible_profile('workload', v_me.workload_position);

  update public.rotation_state
  set current_profile_id = coalesce(v_next, v_me.id),
      version = version + 1,
      updated_at = now(),
      updated_by = v_me.id
  where kind = 'workload';

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id)
  values ('workload', 'claim', v_me.id, v_me.id, coalesce(v_next, v_me.id), v_item.id);

  return v_item;
end;
$function$

