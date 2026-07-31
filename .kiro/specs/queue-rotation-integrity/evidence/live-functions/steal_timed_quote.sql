CREATE OR REPLACE FUNCTION public.steal_timed_quote(p_timer_id uuid)
 RETURNS work_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_timer public.quote_take_timers%rowtype;
  v_state public.rotation_state%rowtype;
  v_current public.profiles%rowtype;
  v_me public.profiles%rowtype;
  v_item public.work_items%rowtype;
  v_next uuid;
  v_position integer;
  v_elapsed integer;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;

  select * into v_timer
  from public.quote_take_timers
  where id = p_timer_id
  for update;
  if not found or v_timer.status <> 'active' then raise exception 'This rescue timer is no longer active'; end if;
  if v_timer.deadline_at > now() then raise exception 'The current agent still has time remaining'; end if;
  if v_timer.current_profile_id = auth.uid() then raise exception 'You own this turn. Use Take Timed Quote instead'; end if;

  select * into v_me
  from public.profiles
  where id = auth.uid() and role = 'agent' and is_active
  for update;
  if not found then raise exception 'Active agent profile not found'; end if;
  if v_me.availability <> 'available' then raise exception 'Set your status to Available before stealing a quote'; end if;
  if v_timer.rotation = 'whatsapp' and not v_me.whatsapp_active then raise exception 'You are paused from the WhatsApp queue'; end if;
  if v_timer.rotation = 'ringcentral' and not v_me.ringcentral_active then raise exception 'You are paused from the RingCentral queue'; end if;

  select * into v_state
  from public.rotation_state
  where kind = v_timer.rotation
  for update;
  if v_state.current_profile_id is distinct from v_timer.current_profile_id then raise exception 'The queue moved and this timer is no longer valid'; end if;

  select * into v_current
  from public.profiles
  where id = v_timer.current_profile_id and role = 'agent' and is_active;
  if not found then raise exception 'The missed agent profile is invalid'; end if;

  insert into public.work_items(
    customer_name, dealer_id, work_type, assigned_profile_id, assignment_method,
    status, note, received_through, created_by, assigned_at, accepted_at
  ) values (
    v_timer.customer_name, v_timer.dealer_id, v_timer.work_type, v_me.id,
    case when v_timer.rotation = 'whatsapp' then 'whatsapp_turn'::public.assignment_method else 'ringcentral_turn'::public.assignment_method end,
    'active', v_timer.note,
    case when v_timer.rotation = 'whatsapp' then 'WhatsApp dealership' else 'RingCentral' end,
    v_me.id, now(), now()
  ) returning * into v_item;

  v_elapsed := greatest(0, floor(extract(epoch from (now() - v_timer.received_at)))::integer);

  update public.quote_take_timers
  set status = 'stolen', claimed_by_profile_id = v_me.id,
      source_work_item_id = v_item.id, completed_at = now()
  where id = v_timer.id;

  insert into public.quote_take_events(
    source_work_item_id, rotation, received_at, taken_at,
    taker_profile_id, skipped_profile_ids, elapsed_seconds
  ) values (
    v_item.id, v_timer.rotation, v_timer.received_at, now(),
    v_me.id, array[v_current.id]::uuid[], v_elapsed
  );

  perform public.add_quote_note_if_present(v_item.id, v_me.id, v_timer.note);

  insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at)
  values (
    v_item.id, 'taken', v_me.id, v_me.id,
    jsonb_build_object(
      'timer_id', v_timer.id,
      'rotation', v_timer.rotation,
      'received_at', v_timer.received_at,
      'elapsed_seconds', v_elapsed,
      'missed_profile_id', v_current.id,
      'skipped_profile_ids', to_jsonb(array[v_current.id]::uuid[])
    ),
    now()
  );

  -- Preserve queue order: advance from the employee whose turn expired.
  v_position := case when v_timer.rotation = 'whatsapp' then v_current.whatsapp_position else v_current.ringcentral_position end;
  v_next := public.next_eligible_profile(v_timer.rotation, v_position);

  update public.rotation_state
  set current_profile_id = v_next, version = version + 1,
      updated_at = now(), updated_by = v_me.id
  where kind = v_timer.rotation;

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id, reason)
  values (
    v_timer.rotation, 'claim', v_me.id, v_current.id, v_next, v_item.id,
    format('Quote stolen after %s seconds; missed current agent %s', v_elapsed, v_current.display_name)
  );

  insert into public.user_notifications(
    recipient_profile_id, notification_type, title, message, entity_type, entity_id
  ) values (
    v_current.id,
    'turn',
    'Quote was stolen',
    format('%s took %s after your 3-minute response period expired. Your turn was consumed and the regular queue order was preserved.', v_me.display_name, v_timer.customer_name),
    'work_item',
    v_item.id
  );

  return v_item;
end;
$function$

