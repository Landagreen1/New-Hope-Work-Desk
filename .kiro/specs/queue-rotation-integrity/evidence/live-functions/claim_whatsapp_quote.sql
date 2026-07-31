CREATE OR REPLACE FUNCTION public.claim_whatsapp_quote(p_customer_name text, p_dealer_id uuid, p_note text DEFAULT NULL::text)
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
  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;
  if v_me.availability <> 'available' or not v_me.whatsapp_active then raise exception 'Set your status to Available before taking a WhatsApp quote'; end if;

  select * into v_state from public.rotation_state where kind = 'whatsapp' for update;
  if not found then raise exception 'WhatsApp queue is not initialized'; end if;
  if v_state.current_profile_id is null then raise exception 'No agent has started the WhatsApp queue today. Click Available to start it'; end if;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This WhatsApp turn belongs to another agent'; end if;

  insert into public.work_items(customer_name, dealer_id, work_type, assigned_profile_id, assignment_method, status, note, received_through, created_by, accepted_at)
  values (trim(p_customer_name), p_dealer_id, 'new_quote', v_me.id, 'whatsapp_turn', 'active', nullif(btrim(p_note), ''), 'WhatsApp dealership', v_me.id, now())
  returning * into v_item;

  perform public.add_quote_note_if_present(v_item.id, v_me.id, p_note);

  v_next := public.next_eligible_profile('whatsapp', v_me.whatsapp_position);

  update public.rotation_state
  set current_profile_id = coalesce(v_next, v_me.id),
      version = version + 1,
      updated_at = now(),
      updated_by = v_me.id
  where kind = 'whatsapp';

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id)
  values ('whatsapp', 'claim', v_me.id, v_me.id, coalesce(v_next, v_me.id), v_item.id);

  return v_item;
end;
$function$

