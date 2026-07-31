CREATE OR REPLACE FUNCTION public.log_payment_v094(p_customer_name text, p_dealer_id uuid, p_salesperson_id uuid, p_note text)
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
  from public.log_payment(p_customer_name, p_dealer_id, p_note);

  update public.work_items
  set salesperson_id = p_salesperson_id
  where id = v_item.id
  returning * into v_item;
  return v_item;
end;
$function$

