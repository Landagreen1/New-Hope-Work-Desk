CREATE OR REPLACE FUNCTION public.start_quote_take_timer(p_rotation rotation_kind, p_received_at timestamp with time zone, p_customer_name text, p_dealer_id uuid, p_work_type work_type, p_note text DEFAULT NULL::text)
 RETURNS quote_take_timers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me public.profiles%rowtype;
  v_current public.profiles%rowtype;
  v_state public.rotation_state%rowtype;
  v_timer public.quote_take_timers%rowtype;
  v_remaining integer;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if p_rotation not in ('whatsapp', 'ringcentral') then raise exception 'Rescue timers are available only for quote queues'; end if;
  if p_received_at is null then raise exception 'Quote received time is required'; end if;
  if p_received_at > now() + interval '30 seconds' then raise exception 'Quote received time cannot be in the future'; end if;
  if now() - p_received_at > interval '24 hours' then raise exception 'The quote received time must be within the last 24 hours'; end if;
  if nullif(btrim(p_customer_name), '') is null then raise exception 'Customer name is required'; end if;
  if p_rotation = 'whatsapp' and p_work_type <> 'new_quote' then raise exception 'WhatsApp accepts new quotes only'; end if;
  if p_rotation = 'ringcentral' and p_work_type not in ('new_quote', 'requote') then raise exception 'RingCentral accepts new quotes or requotes'; end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me
  from public.profiles
  where id = auth.uid() and role = 'agent' and is_active
  for update;
  if not found then raise exception 'Active agent profile not found'; end if;
  if v_me.availability <> 'available' then raise exception 'Set your status to Available before starting a rescue timer'; end if;
  if p_rotation = 'whatsapp' and not v_me.whatsapp_active then raise exception 'You are paused from the WhatsApp queue'; end if;
  if p_rotation = 'ringcentral' and not v_me.ringcentral_active then raise exception 'You are paused from the RingCentral queue'; end if;

  select * into v_state
  from public.rotation_state
  where kind = p_rotation
  for update;
  if not found or v_state.current_profile_id is null then raise exception 'This queue has no current agent'; end if;
  if v_state.current_profile_id = v_me.id then raise exception 'You already own this turn. Use the normal quote action'; end if;

  select * into v_current
  from public.profiles
  where id = v_state.current_profile_id and role = 'agent' and is_active;
  if not found then raise exception 'The current queue agent is invalid. Ask management to review Queue Health'; end if;

  if exists (
    select 1 from public.quote_take_timers
    where rotation = p_rotation and status = 'active'
  ) then
    raise exception 'A rescue timer is already active for this queue';
  end if;

  insert into public.quote_take_timers(
    rotation, current_profile_id, started_by_profile_id,
    received_at, deadline_at, customer_name, dealer_id, work_type, note
  ) values (
    p_rotation, v_current.id, v_me.id,
    p_received_at, p_received_at + interval '3 minutes',
    trim(p_customer_name), p_dealer_id, p_work_type, nullif(btrim(p_note), '')
  ) returning * into v_timer;

  v_remaining := greatest(0, ceil(extract(epoch from (v_timer.deadline_at - now())))::integer);

  insert into public.user_notifications(
    recipient_profile_id, notification_type, title, message, entity_type, entity_id
  ) values (
    v_current.id,
    'turn',
    'Rescue timer started',
    case
      when v_remaining <= 0 then format('%s started a rescue timer for %s. The 3-minute response period has already expired.', v_me.display_name, v_timer.customer_name)
      else format('%s started a rescue timer for %s. You have %s remaining to take your turn.', v_me.display_name, v_timer.customer_name, make_interval(secs => v_remaining)::text)
    end,
    'quote_take_timer',
    v_timer.id
  );

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, new_value, reason)
  values (
    v_me.id,
    'start_quote_take_timer',
    'quote_take_timer',
    v_timer.id,
    jsonb_build_object(
      'rotation', p_rotation,
      'current_profile_id', v_current.id,
      'received_at', p_received_at,
      'deadline_at', v_timer.deadline_at,
      'customer_name', v_timer.customer_name
    ),
    nullif(btrim(p_note), '')
  );

  return v_timer;
end;
$function$

