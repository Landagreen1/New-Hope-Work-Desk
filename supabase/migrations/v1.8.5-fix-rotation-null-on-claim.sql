-- v1.8.5: Fix rotation getting stuck on NULL (showing "No agent yet")
--
-- Bug: When the current agent claims a quote and no other eligible agent is
-- available at that moment, next_eligible_profile() returns NULL. The v0.8.0
-- claim functions unconditionally set current_profile_id = v_next, which NULLs
-- out the rotation. Because no other agent calls set_my_availability() (they
-- are already in their current state), the queue stays stuck until a manager
-- manually reassigns it.
--
-- Fix: After each claim, if v_next is NULL, keep current_profile_id pointing
-- at the claiming agent. The queue stays "live" and the set_my_availability
-- auto-skip logic will hand it to the next eligible agent as soon as one
-- becomes available.

-- 1. claim_whatsapp_quote
create or replace function public.claim_whatsapp_quote(
  p_customer_name text,
  p_dealer_id uuid,
  p_note text default null
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
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

  -- If no eligible next agent, keep rotation on the claimer so the queue
  -- doesn't go NULL. The auto-skip in set_my_availability will hand it off
  -- as soon as someone becomes eligible.
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
$$;

-- 2. claim_ringcentral_quote
create or replace function public.claim_ringcentral_quote(
  p_customer_name text,
  p_dealer_id uuid,
  p_work_type public.work_type,
  p_note text default null
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles%rowtype;
  v_state public.rotation_state%rowtype;
  v_next uuid;
  v_item public.work_items%rowtype;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if p_work_type not in ('new_quote', 'requote') then raise exception 'RingCentral rotation only accepts new quotes or requotes'; end if;
  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;
  if v_me.availability <> 'available' or not v_me.ringcentral_active then raise exception 'Set your status to Available before taking a RingCentral quote'; end if;

  select * into v_state from public.rotation_state where kind = 'ringcentral' for update;
  if not found then raise exception 'RingCentral queue is not initialized'; end if;
  if v_state.current_profile_id is null then raise exception 'No agent has started the RingCentral queue today. Click Available to start it'; end if;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This RingCentral turn belongs to another agent'; end if;

  insert into public.work_items(customer_name, dealer_id, work_type, assigned_profile_id, assignment_method, status, note, received_through, created_by, accepted_at)
  values (trim(p_customer_name), p_dealer_id, p_work_type, v_me.id, 'ringcentral_turn', 'active', nullif(btrim(p_note), ''), 'RingCentral', v_me.id, now())
  returning * into v_item;

  perform public.add_quote_note_if_present(v_item.id, v_me.id, p_note);

  v_next := public.next_eligible_profile('ringcentral', v_me.ringcentral_position);

  update public.rotation_state
  set current_profile_id = coalesce(v_next, v_me.id),
      version = version + 1,
      updated_at = now(),
      updated_by = v_me.id
  where kind = 'ringcentral';

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id)
  values ('ringcentral', 'claim', v_me.id, v_me.id, coalesce(v_next, v_me.id), v_item.id);

  return v_item;
end;
$$;

-- 3. take_quote_turn
create or replace function public.take_quote_turn(
  p_rotation public.rotation_kind,
  p_received_at timestamptz,
  p_customer_name text,
  p_dealer_id uuid,
  p_work_type public.work_type,
  p_note text default null
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
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
$$;

-- 4. claim_linked_workload_turn
create or replace function public.claim_linked_workload_turn(
  p_related_quote_source_work_item_id uuid,
  p_work_type public.work_type,
  p_change_type text default null,
  p_note text default null
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles%rowtype;
  v_state public.rotation_state%rowtype;
  v_next uuid;
  v_item public.work_items%rowtype;
  v_customer_name text;
  v_dealer_id uuid;
  v_quote_owner_id uuid;
  v_quote_assigned_id uuid;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if p_work_type not in ('activation', 'change') then raise exception 'Additional Workload only accepts activations or changes'; end if;
  if p_related_quote_source_work_item_id is null then raise exception 'Select the existing quote this workload belongs to'; end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;
  if v_me.availability <> 'available' or not v_me.workload_active then raise exception 'Set your status to Available before taking Additional Workload'; end if;

  select q.customer_name, q.dealer_id, q.original_owner_profile_id, q.assigned_profile_id
  into v_customer_name, v_dealer_id, v_quote_owner_id, v_quote_assigned_id
  from (
    select w.customer_name, w.dealer_id, w.original_owner_profile_id, w.assigned_profile_id, w.created_at as stage_at
    from public.work_items w
    where w.id = p_related_quote_source_work_item_id
      and w.work_type in ('new_quote', 'requote')
    union all
    select p.customer_name, p.dealer_id, p.original_owner_profile_id, p.assigned_profile_id, p.price_sent_at
    from public.pending_pricing_quotes p
    where p.source_work_item_id = p_related_quote_source_work_item_id
    union all
    select o.customer_name, o.dealer_id, o.original_owner_profile_id, o.assigned_profile_id, o.finalized_at
    from public.quote_outcomes o
    where o.source_work_item_id = p_related_quote_source_work_item_id
  ) q
  order by q.stage_at desc
  limit 1;

  if v_customer_name is null then raise exception 'The selected quote no longer exists'; end if;

  select * into v_state from public.rotation_state where kind = 'workload' for update;
  if not found then raise exception 'Additional Workload queue is not initialized'; end if;
  if v_state.current_profile_id is null then raise exception 'No agent has started the Additional Workload queue today. Click Available to start it'; end if;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This Additional Workload turn belongs to another agent'; end if;

  insert into public.work_items(
    customer_name, dealer_id, work_type, original_owner_profile_id,
    assigned_profile_id, assignment_method, status, change_type, note,
    received_through, created_by, accepted_at, related_quote_source_work_item_id
  ) values (
    v_customer_name, v_dealer_id, p_work_type, coalesce(v_quote_owner_id, v_quote_assigned_id),
    v_me.id, 'workload_turn', 'active', nullif(btrim(p_change_type), ''), nullif(btrim(p_note), ''),
    'Linked quote', v_me.id, now(), p_related_quote_source_work_item_id
  ) returning * into v_item;

  insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at)
  values (
    p_related_quote_source_work_item_id,
    case when p_work_type = 'activation' then 'activation' else 'change' end,
    v_me.id,
    coalesce(v_quote_assigned_id, v_me.id),
    jsonb_build_object('service_work_item_id', v_item.id, 'change_type', nullif(btrim(p_change_type), ''), 'note', nullif(btrim(p_note), '')),
    now()
  );

  perform public.add_quote_note_if_present(p_related_quote_source_work_item_id, v_me.id, p_note);

  if p_work_type = 'activation' then
    perform public.finalize_quote_as_sold_from_activation(p_related_quote_source_work_item_id, v_me.id);
  end if;

  v_next := public.next_eligible_profile('workload', v_me.workload_position);

  update public.rotation_state
  set current_profile_id = coalesce(v_next, v_me.id),
      version = version + 1,
      updated_at = now(),
      updated_by = v_me.id
  where kind = 'workload';

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id)
  values ('workload', 'claim', v_me.id, v_me.id, coalesce(v_next, v_me.id), v_item.id);

  return v_item;
end;
$$;

-- 5. claim_unlinked_workload_turn
create or replace function public.claim_unlinked_workload_turn(
  p_customer_name text,
  p_dealer_id uuid,
  p_work_type public.work_type,
  p_original_owner_profile_id uuid default null,
  p_change_type text default null,
  p_note text default null
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles%rowtype;
  v_state public.rotation_state%rowtype;
  v_next uuid;
  v_item public.work_items%rowtype;
  v_quote_source_id uuid;
  v_quote_agent_id uuid;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if p_work_type not in ('activation', 'change') then raise exception 'Additional Workload only accepts activations or changes'; end if;
  if nullif(btrim(p_customer_name), '') is null then raise exception 'Customer name is required'; end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;
  if v_me.availability <> 'available' or not v_me.workload_active then raise exception 'Set your status to Available before taking Additional Workload'; end if;

  if p_original_owner_profile_id is not null and not exists (
    select 1 from public.profiles where id = p_original_owner_profile_id and role = 'agent' and is_active
  ) then
    raise exception 'Original owner is not an active agent';
  end if;

  select * into v_state from public.rotation_state where kind = 'workload' for update;
  if not found then raise exception 'Additional Workload queue is not initialized'; end if;
  if v_state.current_profile_id is null then raise exception 'No agent has started the Additional Workload queue today. Click Available to start it'; end if;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This Additional Workload turn belongs to another agent'; end if;

  if p_work_type = 'activation' then
    v_quote_source_id := gen_random_uuid();
  end if;

  insert into public.work_items(
    customer_name, dealer_id, work_type, original_owner_profile_id,
    assigned_profile_id, assignment_method, status, change_type, note,
    received_through, created_by, accepted_at, related_quote_source_work_item_id
  ) values (
    trim(p_customer_name), p_dealer_id, p_work_type, p_original_owner_profile_id,
    v_me.id, 'workload_turn', 'active', nullif(btrim(p_change_type), ''), nullif(btrim(p_note), ''),
    'Legacy / Existing business', v_me.id, now(), v_quote_source_id
  ) returning * into v_item;

  if p_work_type = 'activation' then
    v_quote_agent_id := coalesce(p_original_owner_profile_id, v_me.id);

    insert into public.quote_outcomes(
      source_work_item_id, customer_name, dealer_id, work_type,
      original_owner_profile_id, assigned_profile_id, assignment_method,
      received_through, quote_created_at, assigned_at, accepted_at,
      decision, not_sold_reason, not_sold_reason_other, finalized_at
    ) values (
      v_quote_source_id, trim(p_customer_name), p_dealer_id, 'new_quote',
      p_original_owner_profile_id, v_quote_agent_id, 'workload_turn',
      'Legacy / Existing business', now(), now(), now(),
      'sold', null, null, now()
    );

    insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at)
    values (
      v_quote_source_id,
      'activation',
      v_me.id,
      v_quote_agent_id,
      jsonb_build_object('service_work_item_id', v_item.id, 'legacy_entry', true, 'note', nullif(btrim(p_note), '')),
      now()
    );

    perform public.add_quote_note_if_present(v_quote_source_id, v_me.id, p_note);
  end if;

  v_next := public.next_eligible_profile('workload', v_me.workload_position);

  update public.rotation_state
  set current_profile_id = coalesce(v_next, v_me.id),
      version = version + 1,
      updated_at = now(),
      updated_by = v_me.id
  where kind = 'workload';

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id)
  values ('workload', 'claim', v_me.id, v_me.id, coalesce(v_next, v_me.id), v_item.id);

  return v_item;
end;
$$;
