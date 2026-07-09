-- New Hope Work Desk v0.2.x -> v0.3.0 migration
-- Separates active workload, Pending Pricing, and Quote Outcomes.

create extension if not exists pgcrypto;

do $$ begin
  create type public.quote_decision as enum ('sold', 'not_sold');
exception when duplicate_object then null; end $$;

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

create index if not exists pending_pricing_assigned_sent_idx on public.pending_pricing_quotes (assigned_profile_id, price_sent_at);
create index if not exists pending_pricing_sent_idx on public.pending_pricing_quotes (price_sent_at);
create index if not exists quote_outcomes_created_idx on public.quote_outcomes (quote_created_at desc);
create index if not exists quote_outcomes_finalized_idx on public.quote_outcomes (finalized_at desc);
create index if not exists quote_outcomes_agent_idx on public.quote_outcomes (assigned_profile_id, finalized_at desc);

drop trigger if exists pending_pricing_touch_updated_at on public.pending_pricing_quotes;
create trigger pending_pricing_touch_updated_at before update on public.pending_pricing_quotes
for each row execute function public.touch_updated_at();

-- Migrate v0.2 Price Sent quotes out of active workload.
insert into public.pending_pricing_quotes(
  source_work_item_id, customer_name, dealer_id, work_type,
  original_owner_profile_id, assigned_profile_id, assignment_method,
  received_through, note, quote_created_at, price_sent_at
)
select
  w.id, w.customer_name, w.dealer_id, w.work_type,
  w.original_owner_profile_id, w.assigned_profile_id, w.assignment_method,
  w.received_through, w.note, w.created_at, coalesce(w.updated_at, w.created_at)
from public.work_items w
where w.status = 'price_sent'
  and w.work_type in ('new_quote', 'requote')
on conflict (source_work_item_id) do nothing;

-- Migrate already-finalized quote rows into quote_outcomes.
insert into public.quote_outcomes(
  source_work_item_id, customer_name, dealer_id, work_type,
  original_owner_profile_id, assigned_profile_id, assignment_method,
  received_through, quote_created_at, decision, finalized_at
)
select
  w.id, w.customer_name, w.dealer_id, w.work_type,
  w.original_owner_profile_id, w.assigned_profile_id, w.assignment_method,
  w.received_through, w.created_at,
  case when w.status = 'sold' then 'sold'::public.quote_decision else 'not_sold'::public.quote_decision end,
  coalesce(w.completed_at, w.updated_at, now())
from public.work_items w
where w.status in ('sold', 'not_sold')
  and w.work_type in ('new_quote', 'requote');

-- Existing turn-event rows must not block removal of quote work_items.
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
    where constraint_schema = 'public'
      and table_name = 'turn_events'
      and constraint_name = 'turn_events_work_item_id_fkey'
  ) then
    alter table public.turn_events drop constraint turn_events_work_item_id_fkey;
  end if;
end $$;

alter table public.turn_events
  add constraint turn_events_work_item_id_fkey
  foreign key (work_item_id) references public.work_items(id) on delete set null;

delete from public.work_items
where status in ('price_sent', 'sold', 'not_sold')
  and work_type in ('new_quote', 'requote');

drop function if exists public.update_my_quote_status(uuid, public.work_status);

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

  if not found then raise exception 'Only active work items can be reassigned'; end if;

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
select w.id, w.created_at as quote_created_at, null::timestamptz as price_sent_at,
  null::timestamptz as finalized_at, w.customer_name, w.dealer_id, w.work_type,
  w.assigned_profile_id, w.assignment_method, w.received_through,
  'active'::text as lifecycle, null::public.quote_decision as decision
from public.work_items w
where w.status = 'active' and w.work_type in ('new_quote', 'requote')
union all
select p.id, p.quote_created_at, p.price_sent_at, null::timestamptz,
  p.customer_name, p.dealer_id, p.work_type, p.assigned_profile_id,
  p.assignment_method, p.received_through, 'price_sent'::text,
  null::public.quote_decision
from public.pending_pricing_quotes p
union all
select q.id, q.quote_created_at, q.price_sent_at, q.finalized_at,
  q.customer_name, q.dealer_id, q.work_type, q.assigned_profile_id,
  q.assignment_method, q.received_through, q.decision::text, q.decision
from public.quote_outcomes q;

create or replace view public.pending_pricing_follow_up
with (security_invoker = true)
as
select p.*, floor(extract(epoch from (now() - p.price_sent_at)) / 86400)::int as days_waiting
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
where p.is_active;

alter table public.pending_pricing_quotes enable row level security;
alter table public.quote_outcomes enable row level security;

drop policy if exists "Authenticated users can read pending pricing" on public.pending_pricing_quotes;
create policy "Authenticated users can read pending pricing" on public.pending_pricing_quotes for select to authenticated using (true);

drop policy if exists "Authenticated users can read quote outcomes" on public.quote_outcomes;
create policy "Authenticated users can read quote outcomes" on public.quote_outcomes for select to authenticated using (true);

do $$ begin alter publication supabase_realtime add table public.pending_pricing_quotes; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.quote_outcomes; exception when duplicate_object then null; end $$;

grant execute on function public.move_my_quote_to_pending_pricing(uuid) to authenticated;
grant execute on function public.finalize_my_active_quote(uuid, public.quote_decision) to authenticated;
grant execute on function public.finalize_pending_pricing_quote(uuid, public.quote_decision) to authenticated;
grant execute on function public.manager_reassign_pending_pricing(uuid, uuid, text) to authenticated;
