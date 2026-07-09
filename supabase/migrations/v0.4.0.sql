-- New Hope Work Desk v0.3.x -> v0.4.0 migration
-- Adds real login identities, first-login password changes, role-locked agent actions,
-- and keeps managers outside all three agent rotations.

alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists must_change_password boolean not null default true;
create unique index if not exists profiles_username_unique on public.profiles(username) where username is not null;

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
    case when p.rotation_position > p_after_position then 0 else 1 end,
    p.rotation_position
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
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;

  update public.profiles set availability = p_status where id = v_me.id;

  if p_status <> 'available' then
    for v_rotation in select * from public.rotation_state for update loop
      if v_rotation.current_profile_id = v_me.id then
        v_next := public.next_eligible_profile(v_rotation.kind, v_me.rotation_position);
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

  v_next := public.next_eligible_profile('whatsapp', v_me.rotation_position);
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

  v_next := public.next_eligible_profile('ringcentral', v_me.rotation_position);
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

  v_next := public.next_eligible_profile('workload', v_me.rotation_position);
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

  v_next := public.next_eligible_profile(p_rotation, v_me.rotation_position);
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

grant execute on function public.complete_password_change() to authenticated;

-- The bootstrap script fills username values and sets every account to change its temporary password.
-- After running `npm run bootstrap-users`, all profiles used by the app have a non-null username.
