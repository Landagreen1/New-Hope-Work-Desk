CREATE OR REPLACE FUNCTION public.claim_unlinked_workload_turn_v094(p_customer_name text, p_dealer_id uuid, p_salesperson_id uuid, p_work_type work_type, p_original_owner_profile_id uuid DEFAULT NULL::uuid, p_change_type text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
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
  from public.claim_unlinked_workload_turn(
    p_customer_name,
    p_dealer_id,
    p_work_type,
    p_original_owner_profile_id,
    p_change_type,
    p_note
  );

  update public.work_items
  set salesperson_id = p_salesperson_id
  where id = v_item.id
  returning * into v_item;

  -- Legacy/unlinked Activations may create a Sold outcome inside the existing
  -- function before this wrapper receives the work item.
  update public.quote_outcomes
  set salesperson_id = p_salesperson_id
  where source_work_item_id = v_item.id
    and salesperson_id is null;

  return v_item;
end;
$function$

