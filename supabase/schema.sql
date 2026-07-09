-- New Hope Work Desk - production schema v0.7.2
-- Three independent configurable rotations, manager-assigned quotes, persistent alerts, timing analytics, source administration, authenticated users, Pending Pricing, and Quote Outcomes.
-- Run this entire file once in a new Supabase project.

create extension if not exists pgcrypto;

do $$ begin
  create type public.app_role as enum ('agent', 'manager');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.availability_status as enum ('available', 'break', 'unavailable');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.rotation_kind as enum ('whatsapp', 'ringcentral', 'workload');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.work_type as enum ('new_quote', 'requote', 'activation', 'change', 'whatsapp_update');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.assignment_method as enum ('whatsapp_turn', 'ringcentral_turn', 'workload_turn', 'owner', 'update_log', 'manager_manual', 'manual_quote');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.work_status as enum ('active', 'price_sent', 'sold', 'not_sold', 'completed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.quote_decision as enum ('sold', 'not_sold');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  display_name text not null,
  initials text not null check (char_length(initials) between 1 and 4),
  role public.app_role not null default 'agent',
  rotation_position integer not null unique check (rotation_position > 0),
  whatsapp_position integer not null check (whatsapp_position > 0),
  ringcentral_position integer not null check (ringcentral_position > 0),
  workload_position integer not null check (workload_position > 0),
  availability public.availability_status not null default 'unavailable',
  whatsapp_active boolean not null default true,
  ringcentral_active boolean not null default true,
  workload_active boolean not null default true,
  is_active boolean not null default true,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dealers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);

create table if not exists public.rotation_state (
  kind public.rotation_kind primary key,
  current_profile_id uuid references public.profiles(id),
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

create table if not exists public.daily_rotation_starts (
  business_date date not null,
  rotation public.rotation_kind not null,
  starter_profile_id uuid not null references public.profiles(id),
  started_at timestamptz not null default now(),
  primary key (business_date, rotation)
);

create table if not exists public.work_items (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  dealer_id uuid references public.dealers(id),
  work_type public.work_type not null,
  original_owner_profile_id uuid references public.profiles(id),
  assigned_profile_id uuid not null references public.profiles(id),
  assignment_method public.assignment_method not null,
  status public.work_status not null default 'active',
  change_type text,
  note text,
  received_through text,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Price-sent quotes leave work_items completely so they no longer count as agent workload.
create table if not exists public.pending_pricing_quotes (
  id uuid primary key default gen_random_uuid(),
  source_work_item_id uuid not null unique,
  customer_name text not null,
  dealer_id uuid references public.dealers(id),
  work_type public.work_type not null check (work_type in ('new_quote', 'requote')),
  original_owner_profile_id uuid references public.profiles(id),
  assigned_profile_id uuid not null references public.profiles(id),
  assignment_method public.assignment_method not null,
  received_through text,
  note text,
  quote_created_at timestamptz not null,
  price_sent_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quote_outcomes (
  id uuid primary key default gen_random_uuid(),
  source_work_item_id uuid not null,
  customer_name text not null,
  dealer_id uuid references public.dealers(id),
  work_type public.work_type not null check (work_type in ('new_quote', 'requote')),
  original_owner_profile_id uuid references public.profiles(id),
  assigned_profile_id uuid not null references public.profiles(id),
  assignment_method public.assignment_method not null,
  received_through text,
  quote_created_at timestamptz not null,
  price_sent_at timestamptz,
  decision public.quote_decision not null,
  finalized_at timestamptz not null default now()
);

create table if not exists public.turn_events (
  id uuid primary key default gen_random_uuid(),
  rotation public.rotation_kind not null,
  action text not null check (action in ('claim', 'pass', 'manual_change', 'auto_skip', 'daily_start')),
  actor_profile_id uuid references public.profiles(id),
  previous_profile_id uuid references public.profiles(id),
  next_profile_id uuid references public.profiles(id),
  work_item_id uuid references public.work_items(id) on delete set null,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  old_value jsonb,
  new_value jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create unique index if not exists profiles_whatsapp_position_unique on public.profiles (whatsapp_position) where role = 'agent' and is_active;
create unique index if not exists profiles_ringcentral_position_unique on public.profiles (ringcentral_position) where role = 'agent' and is_active;
create unique index if not exists profiles_workload_position_unique on public.profiles (workload_position) where role = 'agent' and is_active;

create index if not exists work_items_assigned_status_idx on public.work_items (assigned_profile_id, status);
create index if not exists work_items_status_created_idx on public.work_items (status, created_at desc);
create index if not exists work_items_created_at_idx on public.work_items (created_at desc);
create index if not exists work_items_method_idx on public.work_items (assignment_method, created_at desc);
create index if not exists turn_events_rotation_created_idx on public.turn_events (rotation, created_at desc);
create index if not exists pending_pricing_assigned_sent_idx on public.pending_pricing_quotes (assigned_profile_id, price_sent_at);
create index if not exists pending_pricing_sent_idx on public.pending_pricing_quotes (price_sent_at);
create index if not exists quote_outcomes_created_idx on public.quote_outcomes (quote_created_at desc);
create index if not exists quote_outcomes_finalized_idx on public.quote_outcomes (finalized_at desc);
create index if not exists quote_outcomes_agent_idx on public.quote_outcomes (assigned_profile_id, finalized_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists work_items_touch_updated_at on public.work_items;
create trigger work_items_touch_updated_at before update on public.work_items
for each row execute function public.touch_updated_at();

drop trigger if exists pending_pricing_touch_updated_at on public.pending_pricing_quotes;
create trigger pending_pricing_touch_updated_at before update on public.pending_pricing_quotes
for each row execute function public.touch_updated_at();

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'manager' and is_active
  );
$$;

create or replace function public.is_agent()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'agent' and is_active
  );
$$;

create or replace function public.current_business_date()
returns date
language sql
stable
as $$
  select (now() at time zone 'America/New_York')::date;
$$;

create or replace function public.next_eligible_profile(
  p_rotation public.rotation_kind,
  p_after_position integer
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.profiles p
  where p.is_active
    and p.role = 'agent'
    and p.availability = 'available'
    and case
      when p_rotation = 'whatsapp' then p.whatsapp_active
      when p_rotation = 'ringcentral' then p.ringcentral_active
      else p.workload_active
    end
  order by
    case when (case
      when p_rotation = 'whatsapp' then p.whatsapp_position
      when p_rotation = 'ringcentral' then p.ringcentral_position
      else p.workload_position
    end) > p_after_position then 0 else 1 end,
    case
      when p_rotation = 'whatsapp' then p.whatsapp_position
      when p_rotation = 'ringcentral' then p.ringcentral_position
      else p.workload_position
    end
  limit 1;
$$;

create or replace function public.set_my_availability(p_status public.availability_status)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles%rowtype;
  v_rotation public.rotation_state%rowtype;
  v_next uuid;
  v_start_id uuid;
  v_previous uuid;
  v_eligible boolean;
  v_current_usable boolean;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;

  update public.profiles set availability = p_status where id = v_me.id;

  -- The first eligible agent to become Available each business day starts that queue.
  -- Normally the same person starts all three queues. Queue-specific pauses are respected.
  if p_status = 'available' then
    for v_rotation in select * from public.rotation_state order by kind for update loop
      v_eligible := case
        when v_rotation.kind = 'whatsapp' then v_me.whatsapp_active
        when v_rotation.kind = 'ringcentral' then v_me.ringcentral_active
        else v_me.workload_active
      end;

      if v_eligible then
        v_start_id := null;
        insert into public.daily_rotation_starts(business_date, rotation, starter_profile_id)
        values (public.current_business_date(), v_rotation.kind, v_me.id)
        on conflict (business_date, rotation) do nothing
        returning starter_profile_id into v_start_id;

        if v_start_id is not null then
          v_previous := v_rotation.current_profile_id;
          update public.rotation_state
          set current_profile_id = v_me.id,
              version = version + 1,
              updated_at = now(),
              updated_by = v_me.id
          where kind = v_rotation.kind;

          insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
          values (v_rotation.kind, 'daily_start', v_me.id, v_previous, v_me.id, 'First eligible agent available for the business day');
        else
          select exists (
            select 1 from public.profiles p
            where p.id = v_rotation.current_profile_id
              and p.is_active
              and p.role = 'agent'
              and p.availability = 'available'
              and case
                when v_rotation.kind = 'whatsapp' then p.whatsapp_active
                when v_rotation.kind = 'ringcentral' then p.ringcentral_active
                else p.workload_active
              end
          ) into v_current_usable;

          -- If a queue was left pointing at an unavailable agent because nobody else
          -- was available at the time, the first eligible returning agent resumes it.
          if not v_current_usable then
            v_previous := v_rotation.current_profile_id;
            update public.rotation_state
            set current_profile_id = v_me.id,
                version = version + 1,
                updated_at = now(),
                updated_by = v_me.id
            where kind = v_rotation.kind;

            insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
            values (v_rotation.kind, 'auto_skip', v_me.id, v_previous, v_me.id, 'Queue resumed when an eligible agent became available');
          end if;
        end if;
      end if;
    end loop;
  else
    for v_rotation in select * from public.rotation_state order by kind for update loop
      if v_rotation.current_profile_id = v_me.id then
        v_next := public.next_eligible_profile(
          v_rotation.kind,
          case
            when v_rotation.kind = 'whatsapp' then v_me.whatsapp_position
            when v_rotation.kind = 'ringcentral' then v_me.ringcentral_position
            else v_me.workload_position
          end
        );
        if v_next is not null and v_next <> v_me.id then
          update public.rotation_state
          set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = v_me.id
          where kind = v_rotation.kind;

          insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
          values (v_rotation.kind, 'auto_skip', v_me.id, v_me.id, v_next, 'Agent became unavailable');
        end if;
      end if;
    end loop;
  end if;
end;
$$;

create or replace function public.claim_whatsapp_quote(
  p_customer_name text,
  p_dealer_id uuid
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
  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;
  if v_me.availability <> 'available' or not v_me.whatsapp_active then raise exception 'You are not eligible for the WhatsApp rotation'; end if;

  select * into v_state from public.rotation_state where kind = 'whatsapp' for update;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This WhatsApp turn belongs to another agent'; end if;

  insert into public.work_items(customer_name, dealer_id, work_type, assigned_profile_id, assignment_method, status, received_through, created_by, accepted_at)
  values (trim(p_customer_name), p_dealer_id, 'new_quote', v_me.id, 'whatsapp_turn', 'active', 'WhatsApp dealership', v_me.id, now())
  returning * into v_item;

  v_next := public.next_eligible_profile('whatsapp', v_me.whatsapp_position);
  if v_next is null then raise exception 'No eligible next agent'; end if;

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
  p_work_type public.work_type
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

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;
  if v_me.availability <> 'available' or not v_me.ringcentral_active then raise exception 'You are not eligible for the RingCentral rotation'; end if;

  select * into v_state from public.rotation_state where kind = 'ringcentral' for update;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This RingCentral turn belongs to another agent'; end if;

  insert into public.work_items(customer_name, dealer_id, work_type, assigned_profile_id, assignment_method, status, received_through, created_by, accepted_at)
  values (trim(p_customer_name), p_dealer_id, p_work_type, v_me.id, 'ringcentral_turn', 'active', 'RingCentral', v_me.id, now())
  returning * into v_item;

  v_next := public.next_eligible_profile('ringcentral', v_me.ringcentral_position);
  if v_next is null then raise exception 'No eligible next agent'; end if;

  update public.rotation_state
  set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = v_me.id
  where kind = 'ringcentral';

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id)
  values ('ringcentral', 'claim', v_me.id, v_me.id, v_next, v_item.id);

  return v_item;
end;
$$;

create or replace function public.claim_workload_turn(
  p_customer_name text,
  p_dealer_id uuid,
  p_work_type public.work_type,
  p_original_owner_profile_id uuid default null,
  p_change_type text default null
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
  if p_work_type not in ('activation', 'change') then raise exception 'Additional Workload only accepts activations or changes'; end if;

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;
  if v_me.availability <> 'available' or not v_me.workload_active then raise exception 'You are not eligible for the Additional Workload rotation'; end if;

  select * into v_state from public.rotation_state where kind = 'workload' for update;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This Additional Workload turn belongs to another agent'; end if;

  insert into public.work_items(customer_name, dealer_id, work_type, original_owner_profile_id, assigned_profile_id, assignment_method, status, change_type, received_through, created_by, accepted_at)
  values (trim(p_customer_name), p_dealer_id, p_work_type, p_original_owner_profile_id, v_me.id, 'workload_turn', 'active', p_change_type, 'Manager routed', v_me.id, now())
  returning * into v_item;

  v_next := public.next_eligible_profile('workload', v_me.workload_position);
  if v_next is null then raise exception 'No eligible next agent'; end if;

  update public.rotation_state
  set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = v_me.id
  where kind = 'workload';

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id)
  values ('workload', 'claim', v_me.id, v_me.id, v_next, v_item.id);

  return v_item;
end;
$$;

create or replace function public.log_whatsapp_update(
  p_customer_name text,
  p_dealer_id uuid,
  p_original_owner_profile_id uuid default null,
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
  select * into v_me from public.profiles where id = auth.uid() and is_active;
  if not found then raise exception 'Active profile not found'; end if;

  insert into public.work_items(customer_name, dealer_id, work_type, original_owner_profile_id, assigned_profile_id, assignment_method, status, note, received_through, created_by, accepted_at, completed_at)
  values (trim(p_customer_name), p_dealer_id, 'whatsapp_update', p_original_owner_profile_id, v_me.id, 'update_log', 'completed', p_note, 'WhatsApp', v_me.id, now(), now())
  returning * into v_item;

  return v_item;
end;
$$;

create or replace function public.log_manual_quote(
  p_customer_name text,
  p_dealer_id uuid,
  p_work_type public.work_type,
  p_received_through text
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
  if nullif(trim(p_received_through), '') is null then raise exception 'A source is required'; end if;

  select * into v_me from public.profiles where id = auth.uid() and is_active;
  if not found then raise exception 'Active profile not found'; end if;

  insert into public.work_items(customer_name, dealer_id, work_type, assigned_profile_id, assignment_method, status, received_through, created_by, accepted_at)
  values (trim(p_customer_name), p_dealer_id, p_work_type, v_me.id, 'manual_quote', 'active', trim(p_received_through), v_me.id, now())
  returning * into v_item;

  return v_item;
end;
$$;

create or replace function public.pass_my_turn(
  p_rotation public.rotation_kind,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles%rowtype;
  v_state public.rotation_state%rowtype;
  v_next uuid;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A pass reason is required'; end if;

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;

  select * into v_state from public.rotation_state where kind = p_rotation for update;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This turn belongs to another agent'; end if;

  v_next := public.next_eligible_profile(p_rotation, case when p_rotation = 'whatsapp' then v_me.whatsapp_position when p_rotation = 'ringcentral' then v_me.ringcentral_position else v_me.workload_position end);
  if v_next is null then raise exception 'No eligible next agent'; end if;

  update public.rotation_state
  set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = v_me.id
  where kind = p_rotation;

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
  values (p_rotation, 'pass', v_me.id, v_me.id, v_next, p_reason);

  return v_next;
end;
$$;

create or replace function public.move_my_quote_to_pending_pricing(
  p_work_item_id uuid
)
returns public.pending_pricing_quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.work_items%rowtype;
  v_pending public.pending_pricing_quotes%rowtype;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  select * into v_item
  from public.work_items
  where id = p_work_item_id
    and assigned_profile_id = auth.uid()
    and status = 'active'
    and work_type in ('new_quote', 'requote')
  for update;

  if not found then raise exception 'Active quote not found or not assigned to you'; end if;

  insert into public.pending_pricing_quotes(
    source_work_item_id, customer_name, dealer_id, work_type,
    original_owner_profile_id, assigned_profile_id, assignment_method,
    received_through, note, quote_created_at, price_sent_at
  ) values (
    v_item.id, v_item.customer_name, v_item.dealer_id, v_item.work_type,
    v_item.original_owner_profile_id, v_item.assigned_profile_id, v_item.assignment_method,
    v_item.received_through, v_item.note, v_item.created_at, now()
  ) returning * into v_pending;

  delete from public.work_items where id = v_item.id;

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, new_value)
  values (auth.uid(), 'quote_moved_to_pending_pricing', 'pending_pricing_quote', v_pending.id, to_jsonb(v_pending));

  return v_pending;
end;
$$;

create or replace function public.finalize_my_active_quote(
  p_work_item_id uuid,
  p_decision public.quote_decision
)
returns public.quote_outcomes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.work_items%rowtype;
  v_outcome public.quote_outcomes%rowtype;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  select * into v_item
  from public.work_items
  where id = p_work_item_id
    and assigned_profile_id = auth.uid()
    and status = 'active'
    and work_type in ('new_quote', 'requote')
  for update;

  if not found then raise exception 'Active quote not found or not assigned to you'; end if;

  insert into public.quote_outcomes(
    source_work_item_id, customer_name, dealer_id, work_type,
    original_owner_profile_id, assigned_profile_id, assignment_method,
    received_through, quote_created_at, decision, finalized_at
  ) values (
    v_item.id, v_item.customer_name, v_item.dealer_id, v_item.work_type,
    v_item.original_owner_profile_id, v_item.assigned_profile_id, v_item.assignment_method,
    v_item.received_through, v_item.created_at, p_decision, now()
  ) returning * into v_outcome;

  delete from public.work_items where id = v_item.id;
  return v_outcome;
end;
$$;

create or replace function public.finalize_pending_pricing_quote(
  p_pending_id uuid,
  p_decision public.quote_decision
)
returns public.quote_outcomes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending public.pending_pricing_quotes%rowtype;
  v_outcome public.quote_outcomes%rowtype;
begin
  select * into v_pending
  from public.pending_pricing_quotes
  where id = p_pending_id
    and (assigned_profile_id = auth.uid() or public.is_manager())
  for update;

  if not found then raise exception 'Pending pricing quote not found or not available to you'; end if;

  insert into public.quote_outcomes(
    source_work_item_id, customer_name, dealer_id, work_type,
    original_owner_profile_id, assigned_profile_id, assignment_method,
    received_through, quote_created_at, price_sent_at, decision, finalized_at
  ) values (
    v_pending.source_work_item_id, v_pending.customer_name, v_pending.dealer_id, v_pending.work_type,
    v_pending.original_owner_profile_id, v_pending.assigned_profile_id, v_pending.assignment_method,
    v_pending.received_through, v_pending.quote_created_at, v_pending.price_sent_at, p_decision, now()
  ) returning * into v_outcome;

  delete from public.pending_pricing_quotes where id = v_pending.id;
  return v_outcome;
end;
$$;

create or replace function public.complete_my_service_item(
  p_work_item_id uuid,
  p_status public.work_status default 'completed'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if p_status not in ('completed', 'cancelled') then raise exception 'Invalid service completion status'; end if;

  update public.work_items
  set status = p_status, completed_at = now()
  where id = p_work_item_id
    and assigned_profile_id = auth.uid()
    and work_type not in ('new_quote', 'requote');

  if not found then raise exception 'Service item not found or not assigned to you'; end if;
end;
$$;

create or replace function public.complete_password_change()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
  set must_change_password = false
  where id = auth.uid() and is_active;

  if not found then raise exception 'Active profile not found'; end if;
end;
$$;

create or replace function public.manager_set_rotation_current(
  p_rotation public.rotation_kind,
  p_profile_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old uuid;
begin
  if not public.is_manager() then raise exception 'Manager permission required'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required'; end if;

  select current_profile_id into v_old from public.rotation_state where kind = p_rotation for update;

  update public.rotation_state
  set current_profile_id = p_profile_id, version = version + 1, updated_at = now(), updated_by = auth.uid()
  where kind = p_rotation;

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
  values (p_rotation, 'manual_change', auth.uid(), v_old, p_profile_id, p_reason);
end;
$$;

create or replace function public.manager_set_rotation_eligibility(
  p_profile_id uuid,
  p_rotation public.rotation_kind,
  p_active boolean,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_profile public.profiles%rowtype;
  v_state public.rotation_state%rowtype;
  v_next uuid;
  v_position integer;
begin
  if not public.is_manager() then raise exception 'Manager permission required'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required'; end if;

  select * into v_profile from public.profiles where id = p_profile_id for update;
  if not found or v_profile.role <> 'agent' then raise exception 'Active agent not found'; end if;
  v_old := to_jsonb(v_profile);

  if p_rotation = 'whatsapp' then
    update public.profiles set whatsapp_active = p_active where id = p_profile_id;
    v_position := v_profile.whatsapp_position;
  elsif p_rotation = 'ringcentral' then
    update public.profiles set ringcentral_active = p_active where id = p_profile_id;
    v_position := v_profile.ringcentral_position;
  else
    update public.profiles set workload_active = p_active where id = p_profile_id;
    v_position := v_profile.workload_position;
  end if;

  -- Pausing the current agent must not leave the queue stuck on someone who cannot act.
  if not p_active then
    select * into v_state from public.rotation_state where kind = p_rotation for update;
    if v_state.current_profile_id = p_profile_id then
      v_next := public.next_eligible_profile(p_rotation, v_position);
      if v_next is not null and v_next <> p_profile_id then
        update public.rotation_state
        set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = auth.uid()
        where kind = p_rotation;

        insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
        values (p_rotation, 'auto_skip', auth.uid(), p_profile_id, v_next, 'Manager paused current agent from queue');
      end if;
    end if;
  end if;

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, old_value, new_value, reason)
  select auth.uid(), 'rotation_eligibility_changed', 'profile', p_profile_id, v_old, to_jsonb(p), p_reason
  from public.profiles p where p.id = p_profile_id;
end;
$$;

create or replace function public.manager_set_queue_order(
  p_rotation public.rotation_kind,
  p_profile_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected integer;
  v_distinct integer;
  v_invalid integer;
  v_index integer;
begin
  if not public.is_manager() then raise exception 'Manager permission required'; end if;

  select count(*) into v_expected from public.profiles where role = 'agent' and is_active;
  select count(distinct id) into v_distinct from unnest(p_profile_ids) as id;
  select count(*) into v_invalid
  from unnest(p_profile_ids) as ids(id)
  left join public.profiles p on p.id = ids.id and p.role = 'agent' and p.is_active
  where p.id is null;

  if coalesce(array_length(p_profile_ids, 1), 0) <> v_expected or v_distinct <> v_expected or v_invalid <> 0 then
    raise exception 'Queue order must include every active agent exactly once';
  end if;

  -- Move the selected queue to temporary positions first so swaps cannot violate unique indexes.
  for v_index in 1..v_expected loop
    if p_rotation = 'whatsapp' then
      update public.profiles set whatsapp_position = 100000 + v_index where id = p_profile_ids[v_index];
    elsif p_rotation = 'ringcentral' then
      update public.profiles set ringcentral_position = 100000 + v_index where id = p_profile_ids[v_index];
    else
      update public.profiles set workload_position = 100000 + v_index where id = p_profile_ids[v_index];
    end if;
  end loop;

  for v_index in 1..v_expected loop
    if p_rotation = 'whatsapp' then
      update public.profiles set whatsapp_position = v_index where id = p_profile_ids[v_index];
    elsif p_rotation = 'ringcentral' then
      update public.profiles set ringcentral_position = v_index where id = p_profile_ids[v_index];
    else
      update public.profiles set workload_position = v_index where id = p_profile_ids[v_index];
    end if;
  end loop;

  insert into public.audit_log(actor_profile_id, action, entity_type, new_value, reason)
  values (auth.uid(), 'queue_order_changed', 'rotation', jsonb_build_object('rotation', p_rotation, 'profile_ids', p_profile_ids), 'Manager reordered queue');
end;
$$;

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
begin
  if not public.is_manager() then raise exception 'Manager permission required'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required'; end if;

  select to_jsonb(w) into v_old from public.work_items w where id = p_work_item_id for update;
  if v_old is null then raise exception 'Work item not found'; end if;

  update public.work_items
  set assigned_profile_id = p_new_profile_id, assignment_method = 'manager_manual'
  where id = p_work_item_id and status = 'active';

  if not found then raise exception 'Only open work items can be reassigned'; end if;

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, old_value, new_value, reason)
  select auth.uid(), 'work_item_reassigned', 'work_item', p_work_item_id, v_old, to_jsonb(w), p_reason
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
begin
  if not public.is_manager() then raise exception 'Manager permission required'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required'; end if;

  select to_jsonb(p) into v_old from public.pending_pricing_quotes p where id = p_pending_id for update;
  if v_old is null then raise exception 'Pending pricing quote not found'; end if;

  update public.pending_pricing_quotes
  set assigned_profile_id = p_new_profile_id, assignment_method = 'manager_manual'
  where id = p_pending_id;

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, old_value, new_value, reason)
  select auth.uid(), 'pending_pricing_reassigned', 'pending_pricing_quote', p_pending_id, v_old, to_jsonb(p), p_reason
  from public.pending_pricing_quotes p where p.id = p_pending_id;
end;
$$;

create or replace view public.quote_reporting_feed
with (security_invoker = true)
as
select
  w.id,
  w.created_at as quote_created_at,
  null::timestamptz as price_sent_at,
  null::timestamptz as finalized_at,
  w.customer_name,
  w.dealer_id,
  w.work_type,
  w.assigned_profile_id,
  w.assignment_method,
  w.received_through,
  'active'::text as lifecycle,
  null::public.quote_decision as decision
from public.work_items w
where w.status = 'active' and w.work_type in ('new_quote', 'requote')
union all
select
  p.id,
  p.quote_created_at,
  p.price_sent_at,
  null::timestamptz,
  p.customer_name,
  p.dealer_id,
  p.work_type,
  p.assigned_profile_id,
  p.assignment_method,
  p.received_through,
  'price_sent'::text,
  null::public.quote_decision
from public.pending_pricing_quotes p
union all
select
  q.id,
  q.quote_created_at,
  q.price_sent_at,
  q.finalized_at,
  q.customer_name,
  q.dealer_id,
  q.work_type,
  q.assigned_profile_id,
  q.assignment_method,
  q.received_through,
  q.decision::text,
  q.decision
from public.quote_outcomes q;

create or replace view public.pending_pricing_follow_up
with (security_invoker = true)
as
select
  p.*,
  floor(extract(epoch from (now() - p.price_sent_at)) / 86400)::int as days_waiting
from public.pending_pricing_quotes p;

create or replace view public.daily_agent_performance
with (security_invoker = true)
as
select
  p.id as profile_id,
  p.display_name,
  (select count(*)::int from public.quote_reporting_feed q where q.assigned_profile_id = p.id and q.assignment_method = 'whatsapp_turn' and q.quote_created_at >= current_date) as whatsapp_quotes,
  (select count(*)::int from public.quote_reporting_feed q where q.assigned_profile_id = p.id and q.assignment_method = 'ringcentral_turn' and q.quote_created_at >= current_date) as ringcentral_quotes,
  (select count(*)::int from public.work_items w where w.assigned_profile_id = p.id and w.assignment_method = 'workload_turn' and w.created_at >= current_date) as workload_turns,
  (select count(*)::int from public.work_items w where w.assigned_profile_id = p.id and w.assignment_method = 'update_log' and w.created_at >= current_date) as whatsapp_updates,
  (select count(*)::int from public.quote_reporting_feed q where q.assigned_profile_id = p.id and q.assignment_method = 'manual_quote' and q.quote_created_at >= current_date) as manual_quotes,
  (select count(*)::int from public.quote_outcomes q where q.assigned_profile_id = p.id and q.decision = 'sold' and q.finalized_at >= current_date) as sold_quotes,
  (select count(*)::int from public.work_items w where w.assigned_profile_id = p.id and w.assignment_method = 'owner' and w.work_type = 'activation' and w.created_at >= current_date) as owned_activations,
  (select count(*)::int from public.work_items w where w.assigned_profile_id = p.id and w.assignment_method = 'owner' and w.work_type = 'change' and w.created_at >= current_date) as owned_changes,
  (select count(*)::int from public.quote_reporting_feed q where q.assigned_profile_id = p.id and q.work_type = 'requote' and q.quote_created_at >= current_date) as requotes,
  (select count(*)::int from public.turn_events te where te.actor_profile_id = p.id and te.action = 'pass' and te.created_at >= current_date) as passed_turns
from public.profiles p
where p.is_active and p.role = 'agent';

alter table public.profiles enable row level security;
alter table public.dealers enable row level security;
alter table public.rotation_state enable row level security;
alter table public.daily_rotation_starts enable row level security;
alter table public.work_items enable row level security;
alter table public.pending_pricing_quotes enable row level security;
alter table public.quote_outcomes enable row level security;
alter table public.turn_events enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists "Authenticated users can read profiles" on public.profiles;
create policy "Authenticated users can read profiles" on public.profiles for select to authenticated using (true);

drop policy if exists "Authenticated users can read dealers" on public.dealers;
create policy "Authenticated users can read dealers" on public.dealers for select to authenticated using (true);

drop policy if exists "Managers can manage dealers" on public.dealers;
create policy "Managers can manage dealers" on public.dealers for all to authenticated using (public.is_manager()) with check (public.is_manager());

drop policy if exists "Authenticated users can read rotations" on public.rotation_state;
create policy "Authenticated users can read rotations" on public.rotation_state for select to authenticated using (true);

drop policy if exists "Authenticated users can read daily rotation starts" on public.daily_rotation_starts;
create policy "Authenticated users can read daily rotation starts" on public.daily_rotation_starts for select to authenticated using (true);

drop policy if exists "Authenticated users can read work items" on public.work_items;
create policy "Authenticated users can read work items" on public.work_items for select to authenticated using (true);

drop policy if exists "Authenticated users can read pending pricing" on public.pending_pricing_quotes;
create policy "Authenticated users can read pending pricing" on public.pending_pricing_quotes for select to authenticated using (true);

drop policy if exists "Authenticated users can read quote outcomes" on public.quote_outcomes;
create policy "Authenticated users can read quote outcomes" on public.quote_outcomes for select to authenticated using (true);

drop policy if exists "Authenticated users can read turn events" on public.turn_events;
create policy "Authenticated users can read turn events" on public.turn_events for select to authenticated using (true);

drop policy if exists "Managers can read audit log" on public.audit_log;
create policy "Managers can read audit log" on public.audit_log for select to authenticated using (public.is_manager());

-- Realtime publication. The manager alert panel is derived from live profiles + work_items.
do $$ begin alter publication supabase_realtime add table public.dealers; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.profiles; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.rotation_state; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.work_items; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.pending_pricing_quotes; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.quote_outcomes; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.turn_events; exception when duplicate_object then null; end $$;

grant execute on function public.complete_password_change() to authenticated;
grant execute on function public.set_my_availability(public.availability_status) to authenticated;
grant execute on function public.claim_whatsapp_quote(text, uuid) to authenticated;
grant execute on function public.claim_ringcentral_quote(text, uuid, public.work_type) to authenticated;
grant execute on function public.claim_workload_turn(text, uuid, public.work_type, uuid, text) to authenticated;
grant execute on function public.log_whatsapp_update(text, uuid, uuid, text) to authenticated;
grant execute on function public.log_manual_quote(text, uuid, public.work_type, text) to authenticated;
grant execute on function public.pass_my_turn(public.rotation_kind, text) to authenticated;
grant execute on function public.move_my_quote_to_pending_pricing(uuid) to authenticated;
grant execute on function public.finalize_my_active_quote(uuid, public.quote_decision) to authenticated;
grant execute on function public.finalize_pending_pricing_quote(uuid, public.quote_decision) to authenticated;
grant execute on function public.complete_my_service_item(uuid, public.work_status) to authenticated;
grant execute on function public.manager_set_rotation_current(public.rotation_kind, uuid, text) to authenticated;
grant execute on function public.manager_set_rotation_eligibility(uuid, public.rotation_kind, boolean, text) to authenticated;
grant execute on function public.manager_set_queue_order(public.rotation_kind, uuid[]) to authenticated;
grant execute on function public.manager_reassign_work_item(uuid, uuid, text) to authenticated;
grant execute on function public.manager_reassign_pending_pricing(uuid, uuid, text) to authenticated;


-- -----------------------------------------------------------------------------
-- v0.7.0 additions for fresh installations
-- -----------------------------------------------------------------------------
-- New Hope Work Desk v0.7.0 migration
-- Manager-assigned quotes, reliable in-app alerts, Not Sold reasons,
-- assignment/acceptance timestamps, and quote-cycle timing reports.
-- Run once after v0.6.0 has been applied successfully.

begin;

-- Preserve assignment and acceptance timestamps across quote lifecycle tables.
alter table public.work_items
  add column if not exists assigned_at timestamptz;

update public.work_items
set assigned_at = coalesce(assigned_at, created_at)
where assigned_at is null;

alter table public.work_items
  alter column assigned_at set default now();

alter table public.pending_pricing_quotes
  add column if not exists assigned_at timestamptz,
  add column if not exists accepted_at timestamptz;

update public.pending_pricing_quotes
set assigned_at = coalesce(assigned_at, quote_created_at),
    accepted_at = coalesce(accepted_at, quote_created_at)
where assigned_at is null or accepted_at is null;

alter table public.quote_outcomes
  add column if not exists assigned_at timestamptz,
  add column if not exists accepted_at timestamptz,
  add column if not exists not_sold_reason text,
  add column if not exists not_sold_reason_other text;

update public.quote_outcomes
set assigned_at = coalesce(assigned_at, quote_created_at),
    accepted_at = coalesce(accepted_at, quote_created_at)
where assigned_at is null or accepted_at is null;

-- Existing Not Sold rows predate reason tracking. Preserve them as clearly labeled legacy records.
update public.quote_outcomes
set not_sold_reason = 'other',
    not_sold_reason_other = coalesce(not_sold_reason_other, 'Legacy record before reason tracking')
where decision = 'not_sold' and not_sold_reason is null;

alter table public.quote_outcomes drop constraint if exists quote_outcomes_not_sold_reason_check;
alter table public.quote_outcomes add constraint quote_outcomes_not_sold_reason_check check (
  decision = 'sold'
  or not_sold_reason in ('price_too_high', 'chose_another_option', 'no_response', 'no_longer_needed', 'other')
);

-- Persistent alert inbox. Browser/desktop notifications are driven from these rows.
create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_profile_id uuid not null references public.profiles(id) on delete cascade,
  notification_type text not null check (notification_type in ('turn', 'assignment')),
  title text not null,
  message text not null,
  entity_type text,
  entity_id uuid,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists user_notifications_recipient_created_idx
  on public.user_notifications (recipient_profile_id, created_at desc);
create index if not exists user_notifications_unread_idx
  on public.user_notifications (recipient_profile_id, read_at, created_at desc);

-- Immutable lifecycle timestamps for operational reporting and auditability.
create table if not exists public.work_item_events (
  id uuid primary key default gen_random_uuid(),
  source_work_item_id uuid not null,
  event_type text not null check (event_type in ('created', 'assigned', 'accepted', 'reassigned', 'price_sent', 'sold', 'not_sold', 'completed', 'cancelled')),
  actor_profile_id uuid references public.profiles(id),
  assigned_profile_id uuid references public.profiles(id),
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists work_item_events_source_idx on public.work_item_events (source_work_item_id, created_at);
create index if not exists work_item_events_agent_idx on public.work_item_events (assigned_profile_id, created_at desc);
create index if not exists work_item_events_type_idx on public.work_item_events (event_type, created_at desc);

-- Trigger: every recorded rotation handoff creates a persistent alert for the next agent.
-- Using turn_events also covers the first daily starter even when the pointer already
-- happened to be on that same employee from the previous day.
create or replace function public.notify_turn_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  v_message text;
begin
  if new.next_profile_id is null then return new; end if;

  v_title := case new.rotation
    when 'whatsapp' then 'Your WhatsApp turn'
    when 'ringcentral' then 'Your RingCentral turn'
    else 'Your Additional Workload turn'
  end;

  v_message := case new.rotation
    when 'whatsapp' then 'You are now first in the WhatsApp New Quotes queue.'
    when 'ringcentral' then 'You are now first in the RingCentral Quotes / Requotes queue.'
    else 'You are now first in the Additional Workload queue.'
  end;

  insert into public.user_notifications(recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (new.next_profile_id, 'turn', v_title, v_message, 'turn_event', new.id);

  return new;
end;
$$;

drop trigger if exists rotation_state_notify_current on public.rotation_state;
drop trigger if exists turn_events_notify_next on public.turn_events;
create trigger turn_events_notify_next
after insert on public.turn_events
for each row execute function public.notify_turn_event();

-- Trigger: manager-created and reassigned active work alerts the assigned agent.
create or replace function public.notify_work_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type_label text;
begin
  v_type_label := case new.work_type
    when 'new_quote' then 'new quote'
    when 'requote' then 'requote'
    when 'activation' then 'activation'
    when 'change' then 'change'
    else 'task'
  end;

  if tg_op = 'INSERT' then
    if new.assigned_profile_id is distinct from new.created_by then
      insert into public.user_notifications(recipient_profile_id, notification_type, title, message, entity_type, entity_id)
      values (
        new.assigned_profile_id,
        'assignment',
        'New work assigned to you',
        format('Management assigned %s for %s to you.', v_type_label, new.customer_name),
        'work_item',
        new.id
      );
    end if;
  elsif new.assigned_profile_id is distinct from old.assigned_profile_id then
    insert into public.user_notifications(recipient_profile_id, notification_type, title, message, entity_type, entity_id)
    values (
      new.assigned_profile_id,
      'assignment',
      'Work reassigned to you',
      format('%s for %s was reassigned to you.', initcap(v_type_label), new.customer_name),
      'work_item',
      new.id
    );
  end if;

  return new;
end;
$$;

drop trigger if exists work_items_notify_assignment on public.work_items;
create trigger work_items_notify_assignment
after insert or update on public.work_items
for each row execute function public.notify_work_assignment();

-- Trigger: pending-pricing follow-up reassignment also alerts the new agent.
create or replace function public.notify_pending_assignment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.assigned_profile_id is distinct from old.assigned_profile_id then
    insert into public.user_notifications(recipient_profile_id, notification_type, title, message, entity_type, entity_id)
    values (
      new.assigned_profile_id,
      'assignment',
      'Pricing follow-up assigned to you',
      format('Follow-up for %s was assigned to you.', new.customer_name),
      'pending_pricing_quote',
      new.id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists pending_pricing_notify_assignment on public.pending_pricing_quotes;
create trigger pending_pricing_notify_assignment
after update of assigned_profile_id on public.pending_pricing_quotes
for each row execute function public.notify_pending_assignment();

-- Trigger-based lifecycle event log. This guarantees timestamps even if UI changes later.
create or replace function public.log_work_item_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at)
    values (new.id, 'created', new.created_by, new.assigned_profile_id, jsonb_build_object('assignment_method', new.assignment_method, 'work_type', new.work_type), new.created_at);

    if new.assigned_profile_id is distinct from new.created_by then
      insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at)
      values (new.id, 'assigned', new.created_by, new.assigned_profile_id, jsonb_build_object('assignment_method', new.assignment_method), coalesce(new.assigned_at, new.created_at));
    end if;

    if new.accepted_at is not null then
      insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, created_at)
      values (new.id, 'accepted', new.assigned_profile_id, new.assigned_profile_id, new.accepted_at);
    end if;
  else
    if new.assigned_profile_id is distinct from old.assigned_profile_id then
      insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at)
      values (new.id, 'reassigned', auth.uid(), new.assigned_profile_id, jsonb_build_object('previous_profile_id', old.assigned_profile_id), coalesce(new.assigned_at, now()));
    end if;

    if old.accepted_at is null and new.accepted_at is not null then
      insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, created_at)
      values (new.id, 'accepted', new.assigned_profile_id, new.assigned_profile_id, new.accepted_at);
    end if;

    if old.status is distinct from new.status and new.status in ('completed', 'cancelled') then
      insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, created_at)
      values (new.id, case when new.status = 'completed' then 'completed' else 'cancelled' end, auth.uid(), new.assigned_profile_id, coalesce(new.completed_at, now()));
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists work_items_log_lifecycle on public.work_items;
create trigger work_items_log_lifecycle
after insert or update on public.work_items
for each row execute function public.log_work_item_event();

create or replace function public.log_pending_pricing_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at)
  values (new.source_work_item_id, 'price_sent', auth.uid(), new.assigned_profile_id, jsonb_build_object('pending_pricing_id', new.id), new.price_sent_at);
  return new;
end;
$$;

drop trigger if exists pending_pricing_log_lifecycle on public.pending_pricing_quotes;
create trigger pending_pricing_log_lifecycle
after insert on public.pending_pricing_quotes
for each row execute function public.log_pending_pricing_event();

create or replace function public.log_quote_outcome_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at)
  values (
    new.source_work_item_id,
    case when new.decision = 'sold' then 'sold' else 'not_sold' end,
    auth.uid(),
    new.assigned_profile_id,
    case when new.decision = 'not_sold' then jsonb_build_object('reason', new.not_sold_reason, 'other', new.not_sold_reason_other) else null end,
    new.finalized_at
  );
  return new;
end;
$$;

drop trigger if exists quote_outcomes_log_lifecycle on public.quote_outcomes;
create trigger quote_outcomes_log_lifecycle
after insert on public.quote_outcomes
for each row execute function public.log_quote_outcome_event();

-- Manager creates and assigns an active quote without moving any rotation.
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

  select * into v_agent from public.profiles
  where id = p_assigned_profile_id and role = 'agent' and is_active;
  if not found then raise exception 'Active agent not found'; end if;

  insert into public.work_items(
    customer_name, dealer_id, work_type, assigned_profile_id, assignment_method,
    status, note, received_through, created_by, assigned_at, accepted_at
  ) values (
    trim(p_customer_name), p_dealer_id, p_work_type, p_assigned_profile_id, 'manager_manual',
    'active', nullif(trim(p_note), ''), trim(p_received_through), auth.uid(), now(), null
  ) returning * into v_item;

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, new_value)
  values (auth.uid(), 'manager_created_assigned_quote', 'work_item', v_item.id, to_jsonb(v_item));

  return v_item;
end;
$$;

-- Assigned work must be explicitly accepted by the receiving agent.
create or replace function public.accept_my_assigned_item(
  p_work_item_id uuid
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.work_items%rowtype;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;

  update public.work_items
  set accepted_at = now()
  where id = p_work_item_id
    and assigned_profile_id = auth.uid()
    and status = 'active'
    and accepted_at is null
  returning * into v_item;

  if not found then raise exception 'Assigned item not found, already accepted, or not assigned to you'; end if;
  return v_item;
end;
$$;

-- Reassignment starts a fresh assignment-to-acceptance clock.
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
  v_target public.profiles%rowtype;
begin
  if not public.is_manager() then raise exception 'Manager permission required'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required'; end if;

  select * into v_target from public.profiles where id = p_new_profile_id and role = 'agent' and is_active;
  if not found then raise exception 'Active agent not found'; end if;

  select to_jsonb(w) into v_old from public.work_items w where id = p_work_item_id for update;
  if v_old is null then raise exception 'Work item not found'; end if;

  update public.work_items
  set assigned_profile_id = p_new_profile_id,
      assignment_method = 'manager_manual',
      assigned_at = now(),
      accepted_at = null
  where id = p_work_item_id;

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, old_value, new_value, reason)
  select auth.uid(), 'work_item_reassigned', 'work_item', p_work_item_id, v_old, to_jsonb(w), p_reason
  from public.work_items w where w.id = p_work_item_id;
end;
$$;

-- Preserve timing data when a quote leaves active workload.
create or replace function public.move_my_quote_to_pending_pricing(
  p_work_item_id uuid
)
returns public.pending_pricing_quotes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.work_items%rowtype;
  v_pending public.pending_pricing_quotes%rowtype;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  select * into v_item
  from public.work_items
  where id = p_work_item_id
    and assigned_profile_id = auth.uid()
    and status = 'active'
    and accepted_at is not null
    and work_type in ('new_quote', 'requote')
  for update;

  if not found then raise exception 'Active accepted quote not found or not assigned to you'; end if;

  insert into public.pending_pricing_quotes(
    source_work_item_id, customer_name, dealer_id, work_type,
    original_owner_profile_id, assigned_profile_id, assignment_method,
    received_through, note, quote_created_at, assigned_at, accepted_at, price_sent_at
  ) values (
    v_item.id, v_item.customer_name, v_item.dealer_id, v_item.work_type,
    v_item.original_owner_profile_id, v_item.assigned_profile_id, v_item.assignment_method,
    v_item.received_through, v_item.note, v_item.created_at, coalesce(v_item.assigned_at, v_item.created_at), v_item.accepted_at, now()
  ) returning * into v_pending;

  delete from public.work_items where id = v_item.id;

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, new_value)
  values (auth.uid(), 'quote_moved_to_pending_pricing', 'pending_pricing_quote', v_pending.id, to_jsonb(v_pending));

  return v_pending;
end;
$$;

-- Replace active quote finalization with reason-aware Not Sold handling.
drop function if exists public.finalize_my_active_quote(uuid, public.quote_decision);
create or replace function public.finalize_my_active_quote(
  p_work_item_id uuid,
  p_decision public.quote_decision,
  p_not_sold_reason text default null,
  p_not_sold_reason_other text default null
)
returns public.quote_outcomes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.work_items%rowtype;
  v_outcome public.quote_outcomes%rowtype;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if p_decision = 'not_sold' then
    if p_not_sold_reason not in ('price_too_high', 'chose_another_option', 'no_response', 'no_longer_needed', 'other') then
      raise exception 'A valid Not Sold reason is required';
    end if;
    if p_not_sold_reason = 'other' and nullif(trim(p_not_sold_reason_other), '') is null then
      raise exception 'Please describe the Other reason';
    end if;
  end if;

  select * into v_item
  from public.work_items
  where id = p_work_item_id
    and assigned_profile_id = auth.uid()
    and status = 'active'
    and accepted_at is not null
    and work_type in ('new_quote', 'requote')
  for update;

  if not found then raise exception 'Active accepted quote not found or not assigned to you'; end if;

  insert into public.quote_outcomes(
    source_work_item_id, customer_name, dealer_id, work_type,
    original_owner_profile_id, assigned_profile_id, assignment_method,
    received_through, quote_created_at, assigned_at, accepted_at,
    decision, not_sold_reason, not_sold_reason_other, finalized_at
  ) values (
    v_item.id, v_item.customer_name, v_item.dealer_id, v_item.work_type,
    v_item.original_owner_profile_id, v_item.assigned_profile_id, v_item.assignment_method,
    v_item.received_through, v_item.created_at, coalesce(v_item.assigned_at, v_item.created_at), v_item.accepted_at,
    p_decision,
    case when p_decision = 'not_sold' then p_not_sold_reason else null end,
    case when p_decision = 'not_sold' and p_not_sold_reason = 'other' then nullif(trim(p_not_sold_reason_other), '') else null end,
    now()
  ) returning * into v_outcome;

  delete from public.work_items where id = v_item.id;
  return v_outcome;
end;
$$;

-- Replace pending pricing finalization with reason-aware Not Sold handling.
drop function if exists public.finalize_pending_pricing_quote(uuid, public.quote_decision);
create or replace function public.finalize_pending_pricing_quote(
  p_pending_id uuid,
  p_decision public.quote_decision,
  p_not_sold_reason text default null,
  p_not_sold_reason_other text default null
)
returns public.quote_outcomes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending public.pending_pricing_quotes%rowtype;
  v_outcome public.quote_outcomes%rowtype;
begin
  if p_decision = 'not_sold' then
    if p_not_sold_reason not in ('price_too_high', 'chose_another_option', 'no_response', 'no_longer_needed', 'other') then
      raise exception 'A valid Not Sold reason is required';
    end if;
    if p_not_sold_reason = 'other' and nullif(trim(p_not_sold_reason_other), '') is null then
      raise exception 'Please describe the Other reason';
    end if;
  end if;

  select * into v_pending
  from public.pending_pricing_quotes
  where id = p_pending_id
    and (assigned_profile_id = auth.uid() or public.is_manager())
  for update;

  if not found then raise exception 'Pending pricing quote not found or not available to you'; end if;

  insert into public.quote_outcomes(
    source_work_item_id, customer_name, dealer_id, work_type,
    original_owner_profile_id, assigned_profile_id, assignment_method,
    received_through, quote_created_at, assigned_at, accepted_at, price_sent_at,
    decision, not_sold_reason, not_sold_reason_other, finalized_at
  ) values (
    v_pending.source_work_item_id, v_pending.customer_name, v_pending.dealer_id, v_pending.work_type,
    v_pending.original_owner_profile_id, v_pending.assigned_profile_id, v_pending.assignment_method,
    v_pending.received_through, v_pending.quote_created_at, v_pending.assigned_at, v_pending.accepted_at, v_pending.price_sent_at,
    p_decision,
    case when p_decision = 'not_sold' then p_not_sold_reason else null end,
    case when p_decision = 'not_sold' and p_not_sold_reason = 'other' then nullif(trim(p_not_sold_reason_other), '') else null end,
    now()
  ) returning * into v_outcome;

  delete from public.pending_pricing_quotes where id = v_pending.id;
  return v_outcome;
end;
$$;

-- Mark persistent alerts as read.
create or replace function public.mark_my_notifications_read()
returns void
language sql
security definer
set search_path = public
as $$
  update public.user_notifications
  set read_at = now()
  where recipient_profile_id = auth.uid() and read_at is null;
$$;

-- RLS and grants for the new tables/functions.
alter table public.user_notifications enable row level security;
alter table public.work_item_events enable row level security;

drop policy if exists "Users can read own notifications" on public.user_notifications;
create policy "Users can read own notifications" on public.user_notifications
for select to authenticated using (recipient_profile_id = auth.uid());

drop policy if exists "Authenticated users can read lifecycle events" on public.work_item_events;
create policy "Authenticated users can read lifecycle events" on public.work_item_events
for select to authenticated using (true);

do $$ begin alter publication supabase_realtime add table public.user_notifications; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.work_item_events; exception when duplicate_object then null; end $$;

grant execute on function public.manager_create_and_assign_quote(text, uuid, public.work_type, text, uuid, text) to authenticated;
grant execute on function public.accept_my_assigned_item(uuid) to authenticated;
grant execute on function public.finalize_my_active_quote(uuid, public.quote_decision, text, text) to authenticated;
grant execute on function public.finalize_pending_pricing_quote(uuid, public.quote_decision, text, text) to authenticated;
grant execute on function public.mark_my_notifications_read() to authenticated;

insert into public.audit_log(actor_profile_id, action, entity_type, new_value, reason)
values (auth.uid(), 'migration_v0_7_0_applied', 'system', jsonb_build_object('version', '0.7.0'), 'Manager assignment, alerts, Not Sold reasons, and timing analytics');

commit;



-- -----------------------------------------------------------------------------
-- v0.7.2 additions for fresh installations
-- -----------------------------------------------------------------------------
-- New Hope Work Desk v0.7.2 migration
-- Manager-selected temporary passwords are an application/API change.
-- This database change resets every active agent to Unavailable at each new
-- America/New_York business date so the first eligible agent to click Available
-- starts the day's rotations.
-- Run once after v0.7.0 has been applied successfully.

begin;

-- Singleton state used to make the daily reset concurrency-safe and idempotent.
create table if not exists public.availability_day_state (
  singleton_key boolean primary key default true check (singleton_key),
  business_date date not null,
  reset_at timestamptz not null default now()
);

insert into public.availability_day_state(singleton_key, business_date, reset_at)
values (true, public.current_business_date(), now())
on conflict (singleton_key) do nothing;

alter table public.availability_day_state enable row level security;
revoke all on table public.availability_day_state from anon, authenticated;

-- Returns true only when this call performs the first reset for a new business day.
-- The advisory transaction lock protects against agents in two offices opening
-- the Work Desk at the same time around midnight.
create or replace function public.ensure_daily_availability_reset()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.current_business_date();
  v_last_business_date date;
begin
  perform pg_advisory_xact_lock(707200072);

  insert into public.availability_day_state(singleton_key, business_date, reset_at)
  values (true, v_today, now())
  on conflict (singleton_key) do nothing;

  select business_date
  into v_last_business_date
  from public.availability_day_state
  where singleton_key = true
  for update;

  if v_last_business_date < v_today then
    update public.profiles
    set availability = 'unavailable'
    where role = 'agent'
      and is_active
      and availability <> 'unavailable';

    update public.availability_day_state
    set business_date = v_today,
        reset_at = now()
    where singleton_key = true;

    return true;
  end if;

  return false;
end;
$$;

-- Reinstall availability changes with the daily reset guard.
create or replace function public.set_my_availability(p_status public.availability_status)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles%rowtype;
  v_rotation public.rotation_state%rowtype;
  v_next uuid;
  v_start_id uuid;
  v_previous uuid;
  v_eligible boolean;
  v_current_usable boolean;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;

  -- Self-healing daily reset: before any status change, make sure a new Eastern
  -- business day starts with every active agent marked Unavailable.
  perform public.ensure_daily_availability_reset();
  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;

  update public.profiles set availability = p_status where id = v_me.id;

  -- The first eligible agent to become Available each business day starts that queue.
  -- Normally the same person starts all three queues. Queue-specific pauses are respected.
  if p_status = 'available' then
    for v_rotation in select * from public.rotation_state order by kind for update loop
      v_eligible := case
        when v_rotation.kind = 'whatsapp' then v_me.whatsapp_active
        when v_rotation.kind = 'ringcentral' then v_me.ringcentral_active
        else v_me.workload_active
      end;

      if v_eligible then
        v_start_id := null;
        insert into public.daily_rotation_starts(business_date, rotation, starter_profile_id)
        values (public.current_business_date(), v_rotation.kind, v_me.id)
        on conflict (business_date, rotation) do nothing
        returning starter_profile_id into v_start_id;

        if v_start_id is not null then
          v_previous := v_rotation.current_profile_id;
          update public.rotation_state
          set current_profile_id = v_me.id,
              version = version + 1,
              updated_at = now(),
              updated_by = v_me.id
          where kind = v_rotation.kind;

          insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
          values (v_rotation.kind, 'daily_start', v_me.id, v_previous, v_me.id, 'First eligible agent available for the business day');
        else
          select exists (
            select 1 from public.profiles p
            where p.id = v_rotation.current_profile_id
              and p.is_active
              and p.role = 'agent'
              and p.availability = 'available'
              and case
                when v_rotation.kind = 'whatsapp' then p.whatsapp_active
                when v_rotation.kind = 'ringcentral' then p.ringcentral_active
                else p.workload_active
              end
          ) into v_current_usable;

          -- If a queue was left pointing at an unavailable agent because nobody else
          -- was available at the time, the first eligible returning agent resumes it.
          if not v_current_usable then
            v_previous := v_rotation.current_profile_id;
            update public.rotation_state
            set current_profile_id = v_me.id,
                version = version + 1,
                updated_at = now(),
                updated_by = v_me.id
            where kind = v_rotation.kind;

            insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
            values (v_rotation.kind, 'auto_skip', v_me.id, v_previous, v_me.id, 'Queue resumed when an eligible agent became available');
          end if;
        end if;
      end if;
    end loop;
  else
    for v_rotation in select * from public.rotation_state order by kind for update loop
      if v_rotation.current_profile_id = v_me.id then
        v_next := public.next_eligible_profile(
          v_rotation.kind,
          case
            when v_rotation.kind = 'whatsapp' then v_me.whatsapp_position
            when v_rotation.kind = 'ringcentral' then v_me.ringcentral_position
            else v_me.workload_position
          end
        );
        if v_next is not null and v_next <> v_me.id then
          update public.rotation_state
          set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = v_me.id
          where kind = v_rotation.kind;

          insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
          values (v_rotation.kind, 'auto_skip', v_me.id, v_me.id, v_next, 'Agent became unavailable');
        end if;
      end if;
    end loop;
  end if;
end;
$$;

revoke execute on function public.ensure_daily_availability_reset() from public, anon;
grant execute on function public.ensure_daily_availability_reset() to authenticated;
grant execute on function public.set_my_availability(public.availability_status) to authenticated;

insert into public.audit_log(actor_profile_id, action, entity_type, new_value, reason)
values (auth.uid(), 'migration_v0_7_2_applied', 'system', jsonb_build_object('version', '0.7.2'), 'Daily availability reset and manager-selected temporary password support');

commit;
