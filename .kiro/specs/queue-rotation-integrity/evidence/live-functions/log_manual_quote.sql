CREATE OR REPLACE FUNCTION public.log_manual_quote(p_customer_name text, p_dealer_id uuid, p_work_type work_type, p_received_through text, p_note text DEFAULT NULL::text)
 RETURNS work_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me public.profiles%rowtype;
  v_item public.work_items%rowtype;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if p_work_type not in ('new_quote', 'requote') then raise exception 'Manual quote must be a new quote or requote'; end if;
  if nullif(trim(p_received_through), '') is null then raise exception 'Input method is required'; end if;
  if nullif(trim(p_customer_name), '') is null then raise exception 'Customer name is required'; end if;

  select * into v_me from public.profiles where id = auth.uid() and is_active;
  if not found then raise exception 'Active profile not found'; end if;

  insert into public.work_items(customer_name, dealer_id, work_type, assigned_profile_id, assignment_method, status, note, received_through, created_by, accepted_at)
  values (trim(p_customer_name), p_dealer_id, p_work_type, v_me.id, 'manual_quote', 'active', nullif(btrim(p_note), ''), trim(p_received_through), v_me.id, now())
  returning * into v_item;

  perform public.add_quote_note_if_present(v_item.id, v_me.id, p_note);
  return v_item;
end;
$function$

