CREATE OR REPLACE FUNCTION public.start_quote_take_timer_v094(p_rotation rotation_kind, p_received_at timestamp with time zone, p_customer_name text, p_dealer_id uuid, p_salesperson_id uuid, p_work_type work_type, p_note text DEFAULT NULL::text)
 RETURNS quote_take_timers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_timer public.quote_take_timers%rowtype;
begin
  if p_rotation::text <> 'whatsapp' then
    raise exception 'The rescue timer is available only for WhatsApp quotes.';
  end if;

  perform public.validate_dealer_salesperson(
    p_dealer_id,
    p_salesperson_id,
    true
  );

  select * into v_timer
  from public.start_quote_take_timer(
    p_rotation,
    p_received_at,
    p_customer_name,
    p_dealer_id,
    p_work_type,
    p_note
  );

  update public.quote_take_timers
  set salesperson_id = p_salesperson_id
  where id = v_timer.id
  returning * into v_timer;

  return v_timer;
end;
$function$

