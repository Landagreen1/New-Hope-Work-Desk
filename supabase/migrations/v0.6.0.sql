-- New Hope Work Desk v0.5.0 -> v0.6.0 migration
-- Adds management dealer administration support, independent queue orders,
-- and the daily first-available starter rule for all three queues.

-- Independent queue positions. Existing installations start with the current common order.
alter table public.profiles add column if not exists whatsapp_position integer;
alter table public.profiles add column if not exists ringcentral_position integer;
alter table public.profiles add column if not exists workload_position integer;

update public.profiles set whatsapp_position = rotation_position where whatsapp_position is null;
update public.profiles set ringcentral_position = rotation_position where ringcentral_position is null;
update public.profiles set workload_position = rotation_position where workload_position is null;

alter table public.profiles alter column whatsapp_position set not null;
alter table public.profiles alter column ringcentral_position set not null;
alter table public.profiles alter column workload_position set not null;

create unique index if not exists profiles_whatsapp_position_unique on public.profiles (whatsapp_position) where role = 'agent' and is_active;
create unique index if not exists profiles_ringcentral_position_unique on public.profiles (ringcentral_position) where role = 'agent' and is_active;
create unique index if not exists profiles_workload_position_unique on public.profiles (workload_position) where role = 'agent' and is_active;

-- Each queue records the first eligible agent who becomes Available on each Eastern business date.
create table if not exists public.daily_rotation_starts (
  business_date date not null,
  rotation public.rotation_kind not null,
  starter_profile_id uuid not null references public.profiles(id),
  started_at timestamptz not null default now(),
  primary key (business_date, rotation)
);

alter table public.daily_rotation_starts enable row level security;
drop policy if exists "Authenticated users can read daily rotation starts" on public.daily_rotation_starts;
create policy "Authenticated users can read daily rotation starts" on public.daily_rotation_starts for select to authenticated using (true);

-- Permit the daily_start audit event in turn history.
alter table public.turn_events drop constraint if exists turn_events_action_check;
alter table public.turn_events add constraint turn_events_action_check
  check (action in ('claim', 'pass', 'manual_change', 'auto_skip', 'daily_start'));

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

-- Manager dealer editing already uses the existing manager RLS policy on public.dealers.
-- Ensure the queue-order function is callable by authenticated sessions and remains manager-guarded internally.
grant execute on function public.manager_set_queue_order(public.rotation_kind, uuid[]) to authenticated;

select 'New Hope Work Desk v0.6.0 migration complete' as migration_status;
