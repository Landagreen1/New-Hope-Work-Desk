-- New Hope Work Desk v0.8.0
-- Shared quote logs, 3-minute Take action, payments, legacy workload entry,
-- activation-to-Sold automation, notes on every interaction, and manager reassignment notes.
-- Run once in Supabase SQL Editor before deploying the v0.8.0 UI.

-- Enum additions must be committed before functions can use the new values.
begin;
alter type public.work_type add value if not exists 'payment';
alter type public.assignment_method add value if not exists 'payment_log';
commit;

begin;

-- Quote Take events persist even after a quote moves Active -> Pending -> Sold/Not Sold.
create table if not exists public.quote_take_events (
  id uuid primary key default gen_random_uuid(),
  source_work_item_id uuid not null unique,
  rotation public.rotation_kind not null check (rotation in ('whatsapp', 'ringcentral')),
  received_at timestamptz not null,
  taken_at timestamptz not null default now(),
  taker_profile_id uuid not null references public.profiles(id),
  skipped_profile_ids uuid[] not null default '{}'::uuid[],
  elapsed_seconds integer not null check (elapsed_seconds >= 0),
  created_at timestamptz not null default now()
);

create index if not exists quote_take_events_taken_idx
  on public.quote_take_events (taken_at desc);

alter table public.quote_take_events enable row level security;

drop policy if exists "Authenticated users can read quote take events" on public.quote_take_events;
create policy "Authenticated users can read quote take events"
  on public.quote_take_events
  for select
  to authenticated
  using (true);

do $$
begin
  alter publication supabase_realtime add table public.quote_take_events;
exception
  when duplicate_object then null;
end $$;

-- Extend lifecycle events so quote logs can show timed Take events and related service work.
alter table public.work_item_events
  drop constraint if exists work_item_events_event_type_check;

alter table public.work_item_events
  add constraint work_item_events_event_type_check check (
    event_type in (
      'created', 'assigned', 'accepted', 'reassigned', 'price_sent', 'sold',
      'not_sold', 'completed', 'cancelled', 'taken', 'activation', 'change', 'payment'
    )
  );

-- Helper: add a note to a quote only when text was supplied.
create or replace function public.add_quote_note_if_present(
  p_source_work_item_id uuid,
  p_author_profile_id uuid,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note text := nullif(btrim(p_note), '');
begin
  if p_source_work_item_id is null or p_author_profile_id is null or v_note is null then
    return;
  end if;

  insert into public.quote_notes(source_work_item_id, author_profile_id, note)
  values (p_source_work_item_id, p_author_profile_id, v_note);
end;
$$;

-- Helper: activation means the underlying quote is a sale.
-- Existing Active, Pending, or Not Sold quote data is converted into one current Sold outcome.
create or replace function public.finalize_quote_as_sold_from_activation(
  p_source_work_item_id uuid,
  p_actor_profile_id uuid
)
returns public.quote_outcomes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active public.work_items%rowtype;
  v_pending public.pending_pricing_quotes%rowtype;
  v_existing public.quote_outcomes%rowtype;
  v_outcome public.quote_outcomes%rowtype;
begin
  if p_source_work_item_id is null then
    raise exception 'Quote id is required';
  end if;

  select * into v_existing
  from public.quote_outcomes
  where source_work_item_id = p_source_work_item_id
    and decision = 'sold'
  order by finalized_at desc
  limit 1;

  if found then
    return v_existing;
  end if;

  select * into v_active
  from public.work_items
  where id = p_source_work_item_id
    and work_type in ('new_quote', 'requote')
  for update;

  if found then
    delete from public.quote_outcomes where source_work_item_id = p_source_work_item_id;
    delete from public.work_items where id = v_active.id;

    insert into public.quote_outcomes(
      source_work_item_id, customer_name, dealer_id, work_type,
      original_owner_profile_id, assigned_profile_id, assignment_method,
      received_through, quote_created_at, assigned_at, accepted_at,
      decision, not_sold_reason, not_sold_reason_other, finalized_at
    ) values (
      v_active.id, v_active.customer_name, v_active.dealer_id, v_active.work_type,
      v_active.original_owner_profile_id, v_active.assigned_profile_id, v_active.assignment_method,
      v_active.received_through, v_active.created_at, coalesce(v_active.assigned_at, v_active.created_at), coalesce(v_active.accepted_at, v_active.created_at),
      'sold', null, null, now()
    ) returning * into v_outcome;

    return v_outcome;
  end if;

  select * into v_pending
  from public.pending_pricing_quotes
  where source_work_item_id = p_source_work_item_id
  for update;

  if found then
    delete from public.quote_outcomes where source_work_item_id = p_source_work_item_id;
    delete from public.pending_pricing_quotes where id = v_pending.id;

    insert into public.quote_outcomes(
      source_work_item_id, customer_name, dealer_id, work_type,
      original_owner_profile_id, assigned_profile_id, assignment_method,
      received_through, quote_created_at, assigned_at, accepted_at,
      price_sent_at, decision, not_sold_reason, not_sold_reason_other, finalized_at
    ) values (
      v_pending.source_work_item_id, v_pending.customer_name, v_pending.dealer_id, v_pending.work_type,
      v_pending.original_owner_profile_id, v_pending.assigned_profile_id, v_pending.assignment_method,
      v_pending.received_through, v_pending.quote_created_at, coalesce(v_pending.assigned_at, v_pending.quote_created_at), coalesce(v_pending.accepted_at, v_pending.quote_created_at),
      v_pending.price_sent_at, 'sold', null, null, now()
    ) returning * into v_outcome;

    return v_outcome;
  end if;

  select * into v_existing
  from public.quote_outcomes
  where source_work_item_id = p_source_work_item_id
  order by finalized_at desc
  limit 1
  for update;

  if found then
    delete from public.quote_outcomes where source_work_item_id = p_source_work_item_id;

    insert into public.quote_outcomes(
      source_work_item_id, customer_name, dealer_id, work_type,
      original_owner_profile_id, assigned_profile_id, assignment_method,
      received_through, quote_created_at, assigned_at, accepted_at,
      price_sent_at, decision, not_sold_reason, not_sold_reason_other, finalized_at
    ) values (
      v_existing.source_work_item_id, v_existing.customer_name, v_existing.dealer_id, v_existing.work_type,
      v_existing.original_owner_profile_id, v_existing.assigned_profile_id, v_existing.assignment_method,
      v_existing.received_through, v_existing.quote_created_at, coalesce(v_existing.assigned_at, v_existing.quote_created_at), coalesce(v_existing.accepted_at, v_existing.quote_created_at),
      v_existing.price_sent_at, 'sold', null, null, now()
    ) returning * into v_outcome;

    return v_outcome;
  end if;

  raise exception 'Quote not found';
end;
$$;

-- Normal current-turn claims now accept notes and copy them into the shared quote log.
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

  update public.rotation_state
  set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = v_me.id
  where kind = 'whatsapp';

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id)
  values ('whatsapp', 'claim', v_me.id, v_me.id, v_next, v_item.id);

  return v_item;
end;
$$;

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
  set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = v_me.id
  where kind = 'ringcentral';

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id)
  values ('ringcentral', 'claim', v_me.id, v_me.id, v_next, v_item.id);

  return v_item;
end;
$$;

-- Timed Take action. Every currently available eligible agent gets a 3-minute window.
-- Current agent = slot 1; after 3 minutes slot 2 may take; after 6 minutes slot 3 may take, etc.
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
  set current_profile_id = v_next,
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
    v_next,
    v_item.id,
    format('Take action after %s seconds; skipped %s eligible agent(s)', v_elapsed_seconds, greatest(v_taker_index - 1, 0))
  );

  return v_item;
end;
$$;

-- Linked workload can now carry notes. Activations automatically convert the linked quote to Sold.
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
  set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = v_me.id
  where kind = 'workload';

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id)
  values ('workload', 'claim', v_me.id, v_me.id, v_next, v_item.id);

  return v_item;
end;
$$;

-- Legacy/older business may not have a quote in Work Desk. This creates workload from new information.
-- For unlinked activations, a synthetic quote identity is created and immediately recorded as Sold.
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
  set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = v_me.id
  where kind = 'workload';

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id)
  values ('workload', 'claim', v_me.id, v_me.id, v_next, v_item.id);

  return v_item;
end;
$$;

-- Payments replace the old WhatsApp Update quick action and do not need a quote link.
create or replace function public.log_payment(
  p_customer_name text,
  p_dealer_id uuid default null,
  p_note text default null
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles%rowtype;
  v_item public.work_items%rowtype;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if nullif(btrim(p_customer_name), '') is null then raise exception 'Customer or account name is required'; end if;
  if nullif(btrim(p_note), '') is null then raise exception 'Payment note is required'; end if;

  select * into v_me from public.profiles where id = auth.uid() and is_active;
  if not found then raise exception 'Active profile not found'; end if;

  insert into public.work_items(
    customer_name, dealer_id, work_type, assigned_profile_id, assignment_method,
    status, note, received_through, created_by, accepted_at, completed_at
  ) values (
    trim(p_customer_name), p_dealer_id, 'payment', v_me.id, 'payment_log',
    'completed', nullif(btrim(p_note), ''), 'Payment', v_me.id, now(), now()
  ) returning * into v_item;

  return v_item;
end;
$$;

-- Manual quotes now support notes and place them in the shared quote log.
create or replace function public.log_manual_quote(
  p_customer_name text,
  p_dealer_id uuid,
  p_work_type public.work_type,
  p_received_through text,
  p_note text default null
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
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
$$;

-- Manager-created assignments now require a note and add it to the quote log.
create or replace function public.manager_create_and_assign_quote(
  p_customer_name text,
  p_dealer_id uuid,
  p_work_type public.work_type,
  p_received_through text,
  p_assigned_profile_id uuid,
  p_note text default null
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.work_items%rowtype;
  v_agent public.profiles%rowtype;
begin
  if not public.is_manager() then raise exception 'Manager permission required'; end if;
  if p_work_type not in ('new_quote', 'requote') then raise exception 'Assigned quote must be a new quote or requote'; end if;
  if nullif(trim(p_customer_name), '') is null then raise exception 'Customer name is required'; end if;
  if nullif(trim(p_received_through), '') is null then raise exception 'Input method is required'; end if;
  if nullif(btrim(p_note), '') is null then raise exception 'An assignment note is required'; end if;

  select * into v_agent from public.profiles
  where id = p_assigned_profile_id and role = 'agent' and is_active;
  if not found then raise exception 'Active agent not found'; end if;

  insert into public.work_items(
    customer_name, dealer_id, work_type, assigned_profile_id, assignment_method,
    status, note, received_through, created_by, assigned_at, accepted_at
  ) values (
    trim(p_customer_name), p_dealer_id, p_work_type, p_assigned_profile_id, 'manager_manual',
    'active', nullif(btrim(p_note), ''), trim(p_received_through), auth.uid(), now(), null
  ) returning * into v_item;

  perform public.add_quote_note_if_present(v_item.id, auth.uid(), p_note);

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, new_value, reason)
  values (auth.uid(), 'manager_created_assigned_quote', 'work_item', v_item.id, to_jsonb(v_item), btrim(p_note));

  return v_item;
end;
$$;

-- Manager reassignments require the manager's note, preserve it in audit history,
-- and add it to the quote log when the task belongs to a quote.
create or replace function public.manager_reassign_work_item(
  p_work_item_id uuid,
  p_new_profile_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_item public.work_items%rowtype;
  v_target public.profiles%rowtype;
  v_quote_source_id uuid;
begin
  if not public.is_manager() then raise exception 'Manager permission required'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A reassignment note is required'; end if;

  select * into v_target from public.profiles where id = p_new_profile_id and role = 'agent' and is_active;
  if not found then raise exception 'Active agent not found'; end if;

  select * into v_item
  from public.work_items
  where id = p_work_item_id
  for update;
  if not found then raise exception 'Work item not found'; end if;
  v_old := to_jsonb(v_item);

  update public.work_items
  set assigned_profile_id = p_new_profile_id,
      assignment_method = 'manager_manual',
      assigned_at = now(),
      accepted_at = null,
      note = case
        when nullif(btrim(note), '') is null then btrim(p_reason)
        else note || E'\n' || btrim(p_reason)
      end
  where id = p_work_item_id;

  v_quote_source_id := case
    when v_item.work_type in ('new_quote', 'requote') then v_item.id
    else v_item.related_quote_source_work_item_id
  end;

  if v_quote_source_id is not null then
    perform public.add_quote_note_if_present(v_quote_source_id, auth.uid(), p_reason);
  end if;

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, old_value, new_value, reason)
  select auth.uid(), 'work_item_reassigned', 'work_item', p_work_item_id, v_old, to_jsonb(w), btrim(p_reason)
  from public.work_items w where w.id = p_work_item_id;
end;
$$;

create or replace function public.manager_reassign_pending_pricing(
  p_pending_id uuid,
  p_new_profile_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_pending public.pending_pricing_quotes%rowtype;
  v_target public.profiles%rowtype;
begin
  if not public.is_manager() then raise exception 'Manager permission required'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A reassignment note is required'; end if;

  select * into v_target from public.profiles where id = p_new_profile_id and role = 'agent' and is_active;
  if not found then raise exception 'Active agent not found'; end if;

  select * into v_pending
  from public.pending_pricing_quotes
  where id = p_pending_id
  for update;
  if not found then raise exception 'Pending pricing quote not found'; end if;
  v_old := to_jsonb(v_pending);

  update public.pending_pricing_quotes
  set assigned_profile_id = p_new_profile_id,
      assignment_method = 'manager_manual',
      assigned_at = now()
  where id = p_pending_id;

  perform public.add_quote_note_if_present(v_pending.source_work_item_id, auth.uid(), p_reason);

  insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at)
  values (
    v_pending.source_work_item_id,
    'reassigned',
    auth.uid(),
    p_new_profile_id,
    jsonb_build_object('previous_profile_id', v_pending.assigned_profile_id, 'reason', btrim(p_reason), 'pending_pricing_id', p_pending_id),
    now()
  );

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, old_value, new_value, reason)
  select auth.uid(), 'pending_pricing_reassigned', 'pending_pricing_quote', p_pending_id, v_old, to_jsonb(p), btrim(p_reason)
  from public.pending_pricing_quotes p where p.id = p_pending_id;
end;
$$;

-- Keep the deletion feature complete for v0.8.0 quote logs and Take records.
create or replace function public.manager_delete_quote(
  p_quote_stage text,
  p_quote_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_source_work_item_id uuid;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if not public.is_manager() then raise exception 'Manager permission required'; end if;
  if p_quote_id is null then raise exception 'Quote id is required'; end if;
  if v_reason is null then raise exception 'Deletion reason is required'; end if;

  if p_quote_stage = 'active' then
    select to_jsonb(w), w.id into v_old, v_source_work_item_id
    from public.work_items w
    where w.id = p_quote_id and w.work_type in ('new_quote', 'requote')
    for update;
    if v_old is null then raise exception 'Active quote not found'; end if;
    delete from public.work_items where id = p_quote_id;
  elsif p_quote_stage = 'pending' then
    select to_jsonb(p), p.source_work_item_id into v_old, v_source_work_item_id
    from public.pending_pricing_quotes p
    where p.id = p_quote_id
    for update;
    if v_old is null then raise exception 'Pending Pricing quote not found'; end if;
    delete from public.pending_pricing_quotes where id = p_quote_id;
  elsif p_quote_stage = 'finalized' then
    select to_jsonb(q), q.source_work_item_id into v_old, v_source_work_item_id
    from public.quote_outcomes q
    where q.id = p_quote_id
    for update;
    if v_old is null then raise exception 'Finalized quote not found'; end if;
    delete from public.quote_outcomes where id = p_quote_id;
  else
    raise exception 'Invalid quote stage. Expected active, pending, or finalized';
  end if;

  delete from public.quote_notes where source_work_item_id = v_source_work_item_id;
  delete from public.quote_take_events where source_work_item_id = v_source_work_item_id;
  delete from public.work_item_events where source_work_item_id = v_source_work_item_id;

  delete from public.user_notifications
  where entity_id = p_quote_id
     or (v_source_work_item_id is not null and entity_id = v_source_work_item_id);

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, old_value, new_value, reason)
  values (
    auth.uid(),
    'quote_deleted',
    'quote',
    p_quote_id,
    v_old,
    jsonb_build_object('stage', p_quote_stage, 'source_work_item_id', v_source_work_item_id, 'deleted_at', now()),
    v_reason
  );
end;
$$;

-- Performance keeps the legacy column name for compatibility, but now counts Payment quick actions.
-- Drop/recreate avoids PostgreSQL view-column rename conflicts on existing databases.
drop view if exists public.daily_agent_performance;
create view public.daily_agent_performance
with (security_invoker = true)
as
select
  p.id as profile_id,
  p.display_name,
  (select count(*)::int from public.quote_reporting_feed q where q.assigned_profile_id = p.id and q.assignment_method = 'whatsapp_turn' and q.quote_created_at >= current_date) as whatsapp_quotes,
  (select count(*)::int from public.quote_reporting_feed q where q.assigned_profile_id = p.id and q.assignment_method = 'ringcentral_turn' and q.quote_created_at >= current_date) as ringcentral_quotes,
  (select count(*)::int from public.work_items w where w.assigned_profile_id = p.id and w.assignment_method = 'workload_turn' and w.created_at >= current_date) as workload_turns,
  (select count(*)::int from public.work_items w where w.assigned_profile_id = p.id and w.assignment_method = 'payment_log' and w.created_at >= current_date) as whatsapp_updates,
  (select count(*)::int from public.quote_reporting_feed q where q.assigned_profile_id = p.id and q.assignment_method = 'manual_quote' and q.quote_created_at >= current_date) as manual_quotes,
  (select count(*)::int from public.quote_outcomes q where q.assigned_profile_id = p.id and q.decision = 'sold' and q.finalized_at >= current_date) as sold_quotes,
  (select count(*)::int from public.work_items w where w.assigned_profile_id = p.id and w.assignment_method = 'owner' and w.work_type = 'activation' and w.created_at >= current_date) as owned_activations,
  (select count(*)::int from public.work_items w where w.assigned_profile_id = p.id and w.assignment_method = 'owner' and w.work_type = 'change' and w.created_at >= current_date) as owned_changes,
  (select count(*)::int from public.quote_reporting_feed q where q.assigned_profile_id = p.id and q.work_type = 'requote' and q.quote_created_at >= current_date) as requotes,
  (select count(*)::int from public.turn_events te where te.actor_profile_id = p.id and te.action = 'pass' and te.created_at >= current_date) as passed_turns
from public.profiles p
where p.is_active and p.role = 'agent';

revoke execute on function public.add_quote_note_if_present(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.finalize_quote_as_sold_from_activation(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.take_quote_turn(public.rotation_kind, timestamptz, text, uuid, public.work_type, text) from public, anon;
revoke execute on function public.log_payment(text, uuid, text) from public, anon;
revoke execute on function public.claim_unlinked_workload_turn(text, uuid, public.work_type, uuid, text, text) from public, anon;

-- Updated signatures: remove execute from old versions where they exist.
revoke execute on function public.claim_whatsapp_quote(text, uuid) from public, anon, authenticated;
revoke execute on function public.claim_ringcentral_quote(text, uuid, public.work_type) from public, anon, authenticated;
revoke execute on function public.claim_linked_workload_turn(uuid, public.work_type, text) from public, anon, authenticated;
revoke execute on function public.log_manual_quote(text, uuid, public.work_type, text) from public, anon, authenticated;

-- Drop old overloads after the new signatures are installed.
drop function if exists public.claim_whatsapp_quote(text, uuid);
drop function if exists public.claim_ringcentral_quote(text, uuid, public.work_type);
drop function if exists public.claim_linked_workload_turn(uuid, public.work_type, text);
drop function if exists public.log_manual_quote(text, uuid, public.work_type, text);

-- Public RPC grants.
grant execute on function public.claim_whatsapp_quote(text, uuid, text) to authenticated;
grant execute on function public.claim_ringcentral_quote(text, uuid, public.work_type, text) to authenticated;
grant execute on function public.take_quote_turn(public.rotation_kind, timestamptz, text, uuid, public.work_type, text) to authenticated;
grant execute on function public.claim_linked_workload_turn(uuid, public.work_type, text, text) to authenticated;
grant execute on function public.claim_unlinked_workload_turn(text, uuid, public.work_type, uuid, text, text) to authenticated;
grant execute on function public.log_payment(text, uuid, text) to authenticated;
grant execute on function public.log_manual_quote(text, uuid, public.work_type, text, text) to authenticated;
grant execute on function public.manager_create_and_assign_quote(text, uuid, public.work_type, text, uuid, text) to authenticated;
grant execute on function public.manager_reassign_work_item(uuid, uuid, text) to authenticated;
grant execute on function public.manager_reassign_pending_pricing(uuid, uuid, text) to authenticated;
grant execute on function public.manager_delete_quote(text, uuid, text) to authenticated;

insert into public.audit_log(actor_profile_id, action, entity_type, new_value, reason)
values (
  auth.uid(),
  'migration_v0_8_0_applied',
  'system',
  jsonb_build_object('version', '0.8.0'),
  'Quote logs, Take action, Payments, legacy workload entry, activation auto-Sold, interaction notes, and manager reassignment notes added'
);

commit;
