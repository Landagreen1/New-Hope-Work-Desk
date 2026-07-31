CREATE OR REPLACE FUNCTION public.log_manual_quote_v094(p_customer_name text, p_dealer_id uuid, p_salesperson_id uuid, p_work_type work_type, p_received_through text, p_note text DEFAULT NULL::text)
 RETURNS work_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_item public.work_items%rowtype;
begin
  if p_dealer_id is not null then
    perform public.validate_dealer_salesperson(p_dealer_id, p_salesperson_id, true);
  elsif p_salesperson_id is not null then
    raise exception 'A salesperson cannot be selected without a source';
  end if;

  select * into v_item
  from public.log_manual_quote(
    p_customer_name,
    p_dealer_id,
    p_work_type,
    p_received_through,
    p_note
  );

  update public.work_items
  set salesperson_id = p_salesperson_id
  where id = v_item.id
  returning * into v_item;
  return v_item;
end;
$function$

