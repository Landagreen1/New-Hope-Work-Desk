-- New Hope Work Desk v0.7.4
-- Queue day-start correction, shared quote linking, and persistent quote follow-up notes.
-- Run once in Supabase SQL Editor before deploying the v0.7.4 UI.

begin;

-- Service work can point back to the stable source work-item id of the quote it belongs to.
alter table public.work_items
  add column if not exists related_quote_source_work_item_id uuid;

create index if not exists work_items_related_quote_idx
  on public.work_items (related_quote_source_work_item_id)
  where related_quote_source_work_item_id is not null;

-- Notes are attached to the stable quote id so they survive Active -> Pending -> Finalized moves.
create table if not exists public.quote_notes (
  id uuid primary key default gen_random_uuid(),
  source_work_item_id uuid not null,
  author_profile_id uuid not null references public.profiles(id),
  note text not null check (char_length(btrim(note)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create index if not exists quote_notes_source_created_idx
  on public.quote_notes (source_work_item_id, created_at desc);

alter table public.quote_notes enable row level security;

drop policy if exists "Authenticated users can read quote notes" on public.quote_notes;
create policy "Authenticated users can read quote notes"
  on public.quote_notes
  for select
  to authenticated
  using (true);

do $$
begin
  alter publication supabase_realtime add table public.quote_notes;
exception
  when duplicate_object then null;
end $$;

create or replace function public.add_quote_note(
  p_source_work_item_id uuid,
  p_note text
)
returns public.quote_notes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_note public.quote_notes%rowtype;
  v_text text := nullif(btrim(p_note), '');
  v_quote_exists boolean;
begin
  select * into v_profile
  from public.profiles
  where id = auth.uid()
    and is_active
    and role in ('agent', 'manager');

  if not found then
    raise exception 'Active agent or manager permission required';
  end if;

  if p_source_work_item_id is null then
    raise exception 'Quote id is required';
  end if;

  if v_text is null then
    raise exception 'A follow-up note is required';
  end if;

  select exists (
    select 1 from public.work_items w
      where w.id = p_source_work_item_id
        and w.work_type in ('new_quote', 'requote')
    union all
    select 1 from public.pending_pricing_quotes p
      where p.source_work_item_id = p_source_work_item_id
    union all
    select 1 from public.quote_outcomes q
      where q.source_work_item_id = p_source_work_item_id
  ) into v_quote_exists;

  if not v_quote_exists then
    raise exception 'Quote not found';
  end if;

  insert into public.quote_notes(source_work_item_id, author_profile_id, note)
  values (p_source_work_item_id, auth.uid(), v_text)
  returning * into v_note;

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, new_value)
  values (auth.uid(), 'quote_note_added', 'quote', p_source_work_item_id, to_jsonb(v_note));

  return v_note;
end;
$$;

-- Every new Eastern business day starts with no current agent on any queue.
-- This removes dependence on yesterday's current agent passing a turn.
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
      and is_active;

    update public.rotation_state
    set current_profile_id = null,
        version = version + 1,
        updated_at = now(),
        updated_by = null;

    -- Yesterday's unread turn alerts should not tell an agent they still own today's turn.
    update public.user_notifications
    set read_at = now()
    where notification_type = 'turn'
      and read_at is null;

    update public.availability_day_state
    set business_date = v_today,
        reset_at = now()
    where singleton_key = true;

    return true;
  end if;

  return false;
end;
$$;

-- The first eligible agent to become Available takes an empty queue.
-- If the last current agent leaves and nobody else is available, the queue becomes empty again.
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
  v_previous uuid;
  v_eligible boolean;
  v_current_usable boolean;
  v_started_today boolean;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me
  from public.profiles
  where id = auth.uid() and is_active
  for update;

  if not found then raise exception 'Active profile not found'; end if;

  update public.profiles
  set availability = p_status
  where id = v_me.id;

  if p_status = 'available' then
    for v_rotation in select * from public.rotation_state order by kind for update loop
      v_eligible := case
        when v_rotation.kind = 'whatsapp' then v_me.whatsapp_active
        when v_rotation.kind = 'ringcentral' then v_me.ringcentral_active
        else v_me.workload_active
      end;

      if v_eligible then
        if v_rotation.current_profile_id is null then
          select exists (
            select 1
            from public.daily_rotation_starts d
            where d.business_date = public.current_business_date()
              and d.rotation = v_rotation.kind
          ) into v_started_today;

          if not v_started_today then
            insert into public.daily_rotation_starts(business_date, rotation, starter_profile_id)
            values (public.current_business_date(), v_rotation.kind, v_me.id)
            on conflict (business_date, rotation) do nothing;
          end if;

          update public.rotation_state
          set current_profile_id = v_me.id,
              version = version + 1,
              updated_at = now(),
              updated_by = v_me.id
          where kind = v_rotation.kind;

          insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
          values (
            v_rotation.kind,
            case when v_started_today then 'auto_skip' else 'daily_start' end,
            v_me.id,
            null,
            v_me.id,
            case when v_started_today then 'Empty queue resumed when an eligible agent became available' else 'First eligible agent available for the business day' end
          );
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

          if not v_current_usable then
            v_previous := v_rotation.current_profile_id;

            update public.rotation_state
            set current_profile_id = v_me.id,
                version = version + 1,
                updated_at = now(),
                updated_by = v_me.id
            where kind = v_rotation.kind;

            insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
            values (v_rotation.kind, 'auto_skip', v_me.id, v_previous, v_me.id, 'Stale queue corrected when an eligible agent became available');
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

        update public.rotation_state
        set current_profile_id = v_next,
            version = version + 1,
            updated_at = now(),
            updated_by = v_me.id
        where kind = v_rotation.kind;

        insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
        values (
          v_rotation.kind,
          'auto_skip',
          v_me.id,
          v_me.id,
          v_next,
          case when v_next is null then 'Agent became unavailable and no eligible agent is currently available' else 'Agent became unavailable' end
        );
      end if;
    end loop;
  end if;
end;
$$;

-- Reinstall claim functions with the daily reset guard and clearer empty-queue errors.
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
  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;
  if v_me.availability <> 'available' or not v_me.whatsapp_active then raise exception 'Set your status to Available before taking a WhatsApp quote'; end if;

  select * into v_state from public.rotation_state where kind = 'whatsapp' for update;
  if v_state.current_profile_id is null then raise exception 'No agent has started the WhatsApp queue today. Click Available to start it'; end if;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This WhatsApp turn belongs to another agent'; end if;

  insert into public.work_items(customer_name, dealer_id, work_type, assigned_profile_id, assignment_method, status, received_through, created_by, accepted_at)
  values (trim(p_customer_name), p_dealer_id, 'new_quote', v_me.id, 'whatsapp_turn', 'active', 'WhatsApp dealership', v_me.id, now())
  returning * into v_item;

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
  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;
  if v_me.availability <> 'available' or not v_me.ringcentral_active then raise exception 'Set your status to Available before taking a RingCentral quote'; end if;

  select * into v_state from public.rotation_state where kind = 'ringcentral' for update;
  if v_state.current_profile_id is null then raise exception 'No agent has started the RingCentral queue today. Click Available to start it'; end if;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This RingCentral turn belongs to another agent'; end if;

  insert into public.work_items(customer_name, dealer_id, work_type, assigned_profile_id, assignment_method, status, received_through, created_by, accepted_at)
  values (trim(p_customer_name), p_dealer_id, p_work_type, v_me.id, 'ringcentral_turn', 'active', 'RingCentral', v_me.id, now())
  returning * into v_item;

  v_next := public.next_eligible_profile('ringcentral', v_me.ringcentral_position);

  update public.rotation_state
  set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = v_me.id
  where kind = 'ringcentral';

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id)
  values ('ringcentral', 'claim', v_me.id, v_me.id, v_next, v_item.id);

  return v_item;
end;
$$;

-- New workload claim: select an existing quote instead of creating duplicate quote details.
create or replace function public.claim_linked_workload_turn(
  p_related_quote_source_work_item_id uuid,
  p_work_type public.work_type,
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
  v_customer_name text;
  v_dealer_id uuid;
  v_quote_owner_id uuid;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if p_work_type not in ('activation', 'change') then raise exception 'Additional Workload only accepts activations or changes'; end if;
  if p_related_quote_source_work_item_id is null then raise exception 'Select the existing quote this workload belongs to'; end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;
  if v_me.availability <> 'available' or not v_me.workload_active then raise exception 'Set your status to Available before taking Additional Workload'; end if;

  select q.customer_name, q.dealer_id, q.assigned_profile_id
  into v_customer_name, v_dealer_id, v_quote_owner_id
  from (
    select w.customer_name, w.dealer_id, w.assigned_profile_id, w.created_at as stage_at
    from public.work_items w
    where w.id = p_related_quote_source_work_item_id
      and w.work_type in ('new_quote', 'requote')
    union all
    select p.customer_name, p.dealer_id, p.assigned_profile_id, p.price_sent_at
    from public.pending_pricing_quotes p
    where p.source_work_item_id = p_related_quote_source_work_item_id
    union all
    select o.customer_name, o.dealer_id, o.assigned_profile_id, o.finalized_at
    from public.quote_outcomes o
    where o.source_work_item_id = p_related_quote_source_work_item_id
  ) q
  order by q.stage_at desc
  limit 1;

  if v_customer_name is null then raise exception 'The selected quote no longer exists'; end if;

  select * into v_state from public.rotation_state where kind = 'workload' for update;
  if v_state.current_profile_id is null then raise exception 'No agent has started the Additional Workload queue today. Click Available to start it'; end if;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This Additional Workload turn belongs to another agent'; end if;

  insert into public.work_items(
    customer_name, dealer_id, work_type, original_owner_profile_id,
    assigned_profile_id, assignment_method, status, change_type,
    received_through, created_by, accepted_at, related_quote_source_work_item_id
  ) values (
    v_customer_name, v_dealer_id, p_work_type, v_quote_owner_id,
    v_me.id, 'workload_turn', 'active', nullif(btrim(p_change_type), ''),
    'Linked quote', v_me.id, now(), p_related_quote_source_work_item_id
  )
  returning * into v_item;

  v_next := public.next_eligible_profile('workload', v_me.workload_position);

  update public.rotation_state
  set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = v_me.id
  where kind = 'workload';

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id)
  values ('workload', 'claim', v_me.id, v_me.id, v_next, v_item.id);

  return v_item;
end;
$$;

-- Keep v0.7.3 deletion behavior, and also remove notes attached to a deleted quote.
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

  delete from public.quote_notes
  where source_work_item_id = v_source_work_item_id;

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

-- Immediately clear stale pointers that currently point to unavailable or ineligible agents.
-- This repairs the live mismatch without waiting for tomorrow's reset.
update public.rotation_state r
set current_profile_id = null,
    version = version + 1,
    updated_at = now(),
    updated_by = null
where r.current_profile_id is not null
  and not exists (
    select 1
    from public.profiles p
    where p.id = r.current_profile_id
      and p.is_active
      and p.role = 'agent'
      and p.availability = 'available'
      and case
        when r.kind = 'whatsapp' then p.whatsapp_active
        when r.kind = 'ringcentral' then p.ringcentral_active
        else p.workload_active
      end
  );

revoke execute on function public.ensure_daily_availability_reset() from public, anon;
revoke execute on function public.set_my_availability(public.availability_status) from public, anon;
revoke execute on function public.add_quote_note(uuid, text) from public, anon;
revoke execute on function public.claim_linked_workload_turn(uuid, public.work_type, text) from public, anon;

grant execute on function public.ensure_daily_availability_reset() to authenticated;
grant execute on function public.set_my_availability(public.availability_status) to authenticated;
grant execute on function public.add_quote_note(uuid, text) to authenticated;
grant execute on function public.claim_whatsapp_quote(text, uuid) to authenticated;
grant execute on function public.claim_ringcentral_quote(text, uuid, public.work_type) to authenticated;
grant execute on function public.claim_linked_workload_turn(uuid, public.work_type, text) to authenticated;
grant execute on function public.manager_delete_quote(text, uuid, text) to authenticated;

insert into public.audit_log(actor_profile_id, action, entity_type, new_value, reason)
values (
  auth.uid(),
  'migration_v0_7_4_applied',
  'system',
  jsonb_build_object('version', '0.7.4'),
  'Empty daily queues, shared quote database linking, and quote follow-up notes added'
);

commit;
