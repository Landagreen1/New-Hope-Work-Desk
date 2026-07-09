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
