CREATE OR REPLACE FUNCTION public.take_quote_turn(p_rotation rotation_kind, p_received_at timestamp with time zone, p_customer_name text, p_dealer_id uuid, p_work_type work_type, p_note text DEFAULT NULL::text)
 RETURNS work_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me public.profiles%rowtype;
  v_state public.rotation_state%rowtype;
  v_current public.profiles%rowtype;
  v_queue_ids uuid[];
  v_taker_index integer;
  v_allowed_index integer;
  v_elapsed_seconds integer;
  v_skipped_ids uuid[] := '{}'::uuid[];
  v_next uuid;
  v_item public.work_items%rowtype;
  v_rotation_position integer;
  v_current_position integer;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if p_rotation not in ('whatsapp', 'ringcentral') then raise exception 'Take is only available for quote rotations'; end if;
  if p_received_at is null then raise exception 'Quote received time is required'; end if;
  if p_received_at > now() + interval '30 seconds' then raise exception 'Quote received time cannot be in the future'; end if;
  if now() - p_received_at > interval '24 hours' then raise exception 'Take can only be used for quotes received within the last 24 hours'; end if;
  if nullif(btrim(p_customer_name), '') is null then raise exception 'Customer name is required'; end if;
  if p_rotation = 'whatsapp' and p_work_type <> 'new_quote' then raise exception 'WhatsApp Take only accepts new quotes'; end if;
  if p_rotation = 'ringcentral' and p_work_type not in ('new_quote', 'requote') then raise exception 'RingCentral Take accepts new quotes or requotes'; end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;
  if v_me.availability <> 'available' then raise exception 'Set your status to Available before using Take'; end if;
  if p_rotation = 'whatsapp' and not v_me.whatsapp_active then raise exception 'You are paused from the WhatsApp queue'; end if;
  if p_rotation = 'ringcentral' and not v_me.ringcentral_active then raise exception 'You are paused from the RingCentral queue'; end if;

  select * into v_state from public.rotation_state where kind = p_rotation for update;
  if not found then raise exception 'Queue is not initialized'; end if;
  if v_state.current_profile_id is null then raise exception 'No agent has started this queue today. Click Available first'; end if;

  select * into v_current from public.profiles where id = v_state.current_profile_id and is_active;
  if not found then raise exception 'Current queue agent is invalid. Refresh and try again'; end if;

  v_current_position := case when p_rotation = 'whatsapp' then v_current.whatsapp_position else v_current.ringcentral_position end;

  select array_agg(q.id order by q.sort_group, q.queue_position)
  into v_queue_ids
  from (
    select
      p.id,
      case when p_rotation = 'whatsapp' then p.whatsapp_position else p.ringcentral_position end as queue_position,
      case when (case when p_rotation = 'whatsapp' then p.whatsapp_position else p.ringcentral_position end) >= v_current_position then 0 else 1 end as sort_group
    from public.profiles p
    where p.role = 'agent'
      and p.is_active
      and p.availability = 'available'
      and case when p_rotation = 'whatsapp' then p.whatsapp_active else p.ringcentral_active end
  ) q;

  if coalesce(array_length(v_queue_ids, 1), 0) = 0 then raise exception 'No available eligible agents are in this queue'; end if;

  v_taker_index := array_position(v_queue_ids, v_me.id);
  if v_taker_index is null then raise exception 'You are not currently eligible to take this queue'; end if;
  if v_taker_index = 1 then raise exception 'You already own this turn. Use the normal queue action instead'; end if;

  v_elapsed_seconds := greatest(0, floor(extract(epoch from (now() - p_received_at)))::integer);
  v_allowed_index := least(array_length(v_queue_ids, 1), floor(v_elapsed_seconds / 180.0)::integer + 1);

  if v_taker_index > v_allowed_index then
    raise exception 'Not enough time has passed. Your 3-minute queue window has not opened yet';
  end if;

  if v_taker_index > 1 then
    v_skipped_ids := v_queue_ids[1:v_taker_index - 1];
  end if;

  insert into public.work_items(
    customer_name, dealer_id, work_type, assigned_profile_id, assignment_method,
    status, note, received_through, created_by, accepted_at
  ) values (
    trim(p_customer_name), p_dealer_id, p_work_type, v_me.id,
    case when p_rotation = 'whatsapp' then 'whatsapp_turn' else 'ringcentral_turn' end,
    'active', nullif(btrim(p_note), ''),
    case when p_rotation = 'whatsapp' then 'WhatsApp dealership' else 'RingCentral' end,
    v_me.id, now()
  ) returning * into v_item;

  insert into public.quote_take_events(
    source_work_item_id, rotation, received_at, taken_at,
    taker_profile_id, skipped_profile_ids, elapsed_seconds
  ) values (
    v_item.id, p_rotation, p_received_at, now(),
    v_me.id, coalesce(v_skipped_ids, '{}'::uuid[]), v_elapsed_seconds
  );

  perform public.add_quote_note_if_present(v_item.id, v_me.id, p_note);

  insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at)
  values (
    v_item.id,
    'taken',
    v_me.id,
    v_me.id,
    jsonb_build_object(
      'rotation', p_rotation,
      'received_at', p_received_at,
      'elapsed_seconds', v_elapsed_seconds,
      'skipped_profile_ids', to_jsonb(coalesce(v_skipped_ids, '{}'::uuid[]))
    ),
    now()
  );

  v_rotation_position := case when p_rotation = 'whatsapp' then v_me.whatsapp_position else v_me.ringcentral_position end;
  v_next := public.next_eligible_profile(p_rotation, v_rotation_position);

  update public.rotation_state
  set current_profile_id = coalesce(v_next, v_me.id),
      version = version + 1,
      updated_at = now(),
      updated_by = v_me.id
  where kind = p_rotation;

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id, reason)
  values (
    p_rotation,
    'claim',
    v_me.id,
    v_state.current_profile_id,
    coalesce(v_next, v_me.id),
    v_item.id,
    format('Take action after %s seconds; skipped %s eligible agent(s)', v_elapsed_seconds, greatest(v_taker_index - 1, 0))
  );

  return v_item;
end;
$function$

