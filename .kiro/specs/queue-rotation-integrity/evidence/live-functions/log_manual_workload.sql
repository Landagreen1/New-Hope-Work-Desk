CREATE OR REPLACE FUNCTION public.log_manual_workload(p_mode text, p_related_quote_source_work_item_id uuid DEFAULT NULL::uuid, p_customer_name text DEFAULT NULL::text, p_dealer_id uuid DEFAULT NULL::uuid, p_salesperson_id uuid DEFAULT NULL::uuid, p_work_type work_type DEFAULT 'change'::work_type, p_original_owner_profile_id uuid DEFAULT NULL::uuid, p_change_type text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS work_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me public.profiles%rowtype;
  v_item public.work_items%rowtype;
  v_customer_name text;
  v_dealer_id uuid;
  v_salesperson_id uuid;
  v_owner_id uuid;
  v_quote_assigned_id uuid;
  v_source_id uuid;
  v_outcome public.quote_outcomes%rowtype;
begin
  select * into v_me
  from public.profiles
  where id = auth.uid()
    and role = 'agent'
    and is_active;
  if not found then
    raise exception 'Active agent permission required';
  end if;

  if p_work_type not in ('activation', 'change') then
    raise exception 'Manual Workload accepts only Activations or Changes';
  end if;

  if p_mode = 'linked' then
    if p_related_quote_source_work_item_id is null then
      raise exception 'Select the existing quote this workload belongs to';
    end if;

    select q.customer_name,
           q.dealer_id,
           q.salesperson_id,
           q.original_owner_profile_id,
           q.assigned_profile_id
      into v_customer_name,
           v_dealer_id,
           v_salesperson_id,
           v_owner_id,
           v_quote_assigned_id
    from (
      select p.customer_name,
             p.dealer_id,
             p.salesperson_id,
             p.original_owner_profile_id,
             p.assigned_profile_id,
             p.price_sent_at as stage_at
      from public.pending_pricing_quotes p
      where p.source_work_item_id = p_related_quote_source_work_item_id
      union all
      select o.customer_name,
             o.dealer_id,
             o.salesperson_id,
             o.original_owner_profile_id,
             o.assigned_profile_id,
             o.finalized_at as stage_at
      from public.quote_outcomes o
      where o.source_work_item_id = p_related_quote_source_work_item_id
        and o.decision = 'sold'
    ) q
    order by q.stage_at desc
    limit 1;

    if v_customer_name is null then
      raise exception 'Only Sold or Pending Pricing quotes can be selected for Manual Workload';
    end if;
    v_source_id := p_related_quote_source_work_item_id;
  elsif p_mode = 'new' then
    v_customer_name := nullif(btrim(p_customer_name), '');
    if v_customer_name is null then
      raise exception 'Customer name is required';
    end if;
    v_dealer_id := p_dealer_id;
    v_salesperson_id := p_salesperson_id;
    v_owner_id := coalesce(p_original_owner_profile_id, v_me.id);
    v_quote_assigned_id := v_owner_id;

    if v_dealer_id is not null then
      perform public.validate_dealer_salesperson(v_dealer_id, v_salesperson_id, true);
    elsif v_salesperson_id is not null then
      raise exception 'A salesperson cannot be selected without a source';
    end if;
  else
    raise exception 'Manual Workload mode must be linked or new';
  end if;

  insert into public.work_items(
    customer_name,
    dealer_id,
    salesperson_id,
    work_type,
    original_owner_profile_id,
    assigned_profile_id,
    assignment_method,
    status,
    change_type,
    note,
    received_through,
    created_by,
    assigned_at,
    accepted_at,
    related_quote_source_work_item_id
  ) values (
    v_customer_name,
    v_dealer_id,
    v_salesperson_id,
    p_work_type,
    coalesce(v_owner_id, v_quote_assigned_id, v_me.id),
    v_me.id,
    'manual_workload'::public.assignment_method,
    'active',
    nullif(btrim(p_change_type), ''),
    nullif(btrim(p_note), ''),
    'Manual workload',
    v_me.id,
    now(),
    now(),
    case when p_mode = 'linked' then v_source_id else null end
  ) returning * into v_item;

  v_source_id := coalesce(v_source_id, v_item.id);

  insert into public.work_item_events(
    source_work_item_id,
    event_type,
    actor_profile_id,
    assigned_profile_id,
    details,
    created_at
  ) values (
    v_source_id,
    case when p_work_type = 'activation' then 'activation' else 'change' end,
    v_me.id,
    coalesce(v_quote_assigned_id, v_owner_id, v_me.id),
    jsonb_build_object(
      'service_work_item_id', v_item.id,
      'source', 'manual_workload',
      'change_type', nullif(btrim(p_change_type), ''),
      'note', nullif(btrim(p_note), '')
    ),
    now()
  );

  if p_mode = 'linked' then
    perform public.add_quote_note_if_present(v_source_id, v_me.id, p_note);
    if p_work_type = 'activation' then
      perform public.finalize_quote_as_sold_from_activation(v_source_id, v_me.id);
    end if;
  elsif p_work_type = 'activation' then
    insert into public.quote_outcomes(
      source_work_item_id,
      customer_name,
      dealer_id,
      salesperson_id,
      work_type,
      original_owner_profile_id,
      assigned_profile_id,
      assignment_method,
      received_through,
      quote_created_at,
      assigned_at,
      accepted_at,
      decision,
      finalized_at
    ) values (
      v_item.id,
      v_customer_name,
      v_dealer_id,
      v_salesperson_id,
      'new_quote',
      coalesce(v_owner_id, v_me.id),
      coalesce(v_owner_id, v_me.id),
      'manual_workload'::public.assignment_method,
      'Old / Not in System',
      v_item.created_at,
      v_item.assigned_at,
      v_item.accepted_at,
      'sold',
      now()
    ) returning * into v_outcome;

    if nullif(btrim(p_note), '') is not null then
      insert into public.quote_notes(source_work_item_id, author_profile_id, note)
      values (v_item.id, v_me.id, btrim(p_note));
    end if;
  end if;

  insert into public.audit_log(
    actor_profile_id,
    action,
    entity_type,
    entity_id,
    new_value,
    reason
  ) values (
    v_me.id,
    'manual_workload_logged',
    'work_item',
    v_item.id,
    to_jsonb(v_item),
    'Logged without moving the Additional Workload rotation'
  );

  return v_item;
end;
$function$

