CREATE OR REPLACE FUNCTION public.claim_unlinked_workload_turn(p_customer_name text, p_dealer_id uuid, p_work_type work_type, p_original_owner_profile_id uuid DEFAULT NULL::uuid, p_change_type text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
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
  v_quote_source_id uuid;
  v_quote_agent_id uuid;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if p_work_type not in ('activation', 'change') then raise exception 'Additional Workload only accepts activations or changes'; end if;
  if nullif(btrim(p_customer_name), '') is null then raise exception 'Customer name is required'; end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;
  if v_me.availability <> 'available' or not v_me.workload_active then raise exception 'Set your status to Available before taking Additional Workload'; end if;

  if p_original_owner_profile_id is not null and not exists (
    select 1 from public.profiles where id = p_original_owner_profile_id and role = 'agent' and is_active
  ) then
    raise exception 'Original owner is not an active agent';
  end if;

  select * into v_state from public.rotation_state where kind = 'workload' for update;
  if not found then raise exception 'Additional Workload queue is not initialized'; end if;
  if v_state.current_profile_id is null then raise exception 'No agent has started the Additional Workload queue today. Click Available to start it'; end if;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This Additional Workload turn belongs to another agent'; end if;

  if p_work_type = 'activation' then
    v_quote_source_id := gen_random_uuid();
  end if;

  insert into public.work_items(
    customer_name, dealer_id, work_type, original_owner_profile_id,
    assigned_profile_id, assignment_method, status, change_type, note,
    received_through, created_by, accepted_at, related_quote_source_work_item_id
  ) values (
    trim(p_customer_name), p_dealer_id, p_work_type, p_original_owner_profile_id,
    v_me.id, 'workload_turn', 'active', nullif(btrim(p_change_type), ''), nullif(btrim(p_note), ''),
    'Legacy / Existing business', v_me.id, now(), v_quote_source_id
  ) returning * into v_item;

  if p_work_type = 'activation' then
    v_quote_agent_id := coalesce(p_original_owner_profile_id, v_me.id);

    insert into public.quote_outcomes(
      source_work_item_id, customer_name, dealer_id, work_type,
      original_owner_profile_id, assigned_profile_id, assignment_method,
      received_through, quote_created_at, assigned_at, accepted_at,
      decision, not_sold_reason, not_sold_reason_other, finalized_at
    ) values (
      v_quote_source_id, trim(p_customer_name), p_dealer_id, 'new_quote',
      p_original_owner_profile_id, v_quote_agent_id, 'workload_turn',
      'Legacy / Existing business', now(), now(), now(),
      'sold', null, null, now()
    );

    insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at)
    values (
      v_quote_source_id,
      'activation',
      v_me.id,
      v_quote_agent_id,
      jsonb_build_object('service_work_item_id', v_item.id, 'legacy_entry', true, 'note', nullif(btrim(p_note), '')),
      now()
    );

    perform public.add_quote_note_if_present(v_quote_source_id, v_me.id, p_note);
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

