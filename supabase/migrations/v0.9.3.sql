-- New Hope Work Desk v0.9.3
-- Customer Service role, manager-entered temporary passwords,
-- workload queue restrictions, and Not Sold -> Sold recovery.
-- Run once after v0.9.2.

-- The enum value must be committed before it can be used by later statements.
alter type public.app_role add value if not exists 'customer_service';

begin;

-- Existing Customer Service overflow selections were previously Agent accounts.
-- Disable that old selection so management can choose a dedicated CS account.
update public.work_desk_settings s
set customer_service_overflow_enabled = false,
    customer_service_profile_id = null,
    updated_at = now(),
    updated_by = null
where s.customer_service_profile_id is not null
  and not exists (
    select 1
    from public.profiles p
    where p.id = s.customer_service_profile_id
      and p.role = 'customer_service'
      and p.is_active
  );

-- Customer Service users may add notes to the quote records assigned to them.
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
    and role in ('agent', 'manager', 'customer_service');

  if not found then
    raise exception 'Active Work Desk user permission required';
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

-- Additional Workload itself cannot be passed. An agent must take the task;
-- after accepting it, the separate Customer Service handoff can be used.
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
  if p_rotation = 'workload' then
    raise exception 'Additional Workload turns cannot be passed. Take the task and use Customer Service overflow after acceptance when needed.';
  end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A pass reason is required'; end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;

  select * into v_state from public.rotation_state where kind = p_rotation for update;
  if v_state.current_profile_id is distinct from v_me.id then raise exception 'This turn belongs to another agent'; end if;

  v_next := public.next_eligible_profile(
    p_rotation,
    case when p_rotation = 'whatsapp' then v_me.whatsapp_position else v_me.ringcentral_position end
  );
  if v_next is null then raise exception 'No eligible next agent'; end if;

  update public.rotation_state
  set current_profile_id = v_next,
      version = version + 1,
      updated_at = now(),
      updated_by = v_me.id
  where kind = p_rotation;

  insert into public.turn_events(rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
  values (p_rotation, 'pass', v_me.id, v_me.id, v_next, btrim(p_reason));

  return v_next;
end;
$$;

-- Agents and Customer Service staff can accept work assigned directly to them.
-- CS accounts are restricted to CS-assigned Activations and Changes.
create or replace function public.accept_my_assigned_item(
  p_work_item_id uuid
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
  v_item public.work_items%rowtype;
begin
  select * into v_profile
  from public.profiles
  where id = auth.uid()
    and is_active
    and role in ('agent', 'customer_service');

  if not found then raise exception 'Active Agent or Customer Service profile required'; end if;

  update public.work_items
  set accepted_at = now(),
      updated_at = now()
  where id = p_work_item_id
    and assigned_profile_id = auth.uid()
    and status = 'active'
    and accepted_at is null
    and (
      v_profile.role = 'agent'
      or (
        v_profile.role = 'customer_service'
        and assignment_method = 'customer_service'
        and work_type in ('activation', 'change')
      )
    )
  returning * into v_item;

  if not found then raise exception 'Assigned item not found, already accepted, or not available to your role'; end if;
  return v_item;
end;
$$;

-- Customer Service staff can complete only CS-assigned Activations and Changes.
create or replace function public.complete_my_service_item(
  p_work_item_id uuid,
  p_status public.work_status default 'completed'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile
  from public.profiles
  where id = auth.uid()
    and is_active
    and role in ('agent', 'customer_service');

  if not found then raise exception 'Active Agent or Customer Service profile required'; end if;
  if p_status not in ('completed', 'cancelled') then raise exception 'Invalid service completion status'; end if;

  update public.work_items
  set status = p_status,
      completed_at = now(),
      updated_at = now()
  where id = p_work_item_id
    and assigned_profile_id = auth.uid()
    and work_type not in ('new_quote', 'requote')
    and (
      v_profile.role = 'agent'
      or (
        v_profile.role = 'customer_service'
        and assignment_method = 'customer_service'
        and work_type in ('activation', 'change')
      )
    );

  if not found then raise exception 'Service item not found or not available to your role'; end if;
end;
$$;

-- Managers can select only a dedicated Customer Service account for overflow.
create or replace function public.manager_update_customer_service_overflow(
  p_enabled boolean,
  p_customer_service_profile_id uuid default null
)
returns public.work_desk_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target public.profiles%rowtype;
  v_settings public.work_desk_settings%rowtype;
begin
  if not public.is_manager() then raise exception 'Manager permission required'; end if;

  if p_enabled then
    if p_customer_service_profile_id is null then raise exception 'Select a Customer Service account before enabling overflow'; end if;
    select * into v_target
    from public.profiles
    where id = p_customer_service_profile_id
      and role = 'customer_service'
      and is_active;
    if not found then raise exception 'The overflow assignee must have the Customer Service role'; end if;
  elsif p_customer_service_profile_id is not null then
    select * into v_target
    from public.profiles
    where id = p_customer_service_profile_id
      and role = 'customer_service'
      and is_active;
    if not found then raise exception 'Selected Customer Service account is not active'; end if;
  end if;

  insert into public.work_desk_settings(
    singleton_id,
    customer_service_overflow_enabled,
    customer_service_profile_id,
    updated_at,
    updated_by
  ) values (
    true,
    coalesce(p_enabled, false),
    p_customer_service_profile_id,
    now(),
    auth.uid()
  )
  on conflict (singleton_id) do update set
    customer_service_overflow_enabled = excluded.customer_service_overflow_enabled,
    customer_service_profile_id = excluded.customer_service_profile_id,
    updated_at = now(),
    updated_by = auth.uid()
  returning * into v_settings;

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, new_value, reason)
  values (
    auth.uid(),
    'update_customer_service_overflow',
    'work_desk_settings',
    null,
    jsonb_build_object(
      'enabled', v_settings.customer_service_overflow_enabled,
      'customer_service_profile_id', v_settings.customer_service_profile_id
    ),
    case when v_settings.customer_service_overflow_enabled
      then 'Customer Service overflow enabled'
      else 'Customer Service overflow disabled'
    end
  );

  return v_settings;
end;
$$;

-- Handoffs now require a true Customer Service account.
create or replace function public.pass_workload_to_customer_service(
  p_work_item_id uuid,
  p_reason text,
  p_handoff_note text
)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.work_desk_settings%rowtype;
  v_me public.profiles%rowtype;
  v_target public.profiles%rowtype;
  v_item public.work_items%rowtype;
  v_log_source_id uuid;
  v_combined_note text;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A pass reason is required'; end if;
  if nullif(btrim(p_handoff_note), '') is null then raise exception 'Describe what is being passed to Customer Service'; end if;

  select * into v_settings
  from public.work_desk_settings
  where singleton_id = true;
  if not found or not v_settings.customer_service_overflow_enabled then raise exception 'Customer Service overflow is not enabled'; end if;
  if v_settings.customer_service_profile_id is null then raise exception 'Management has not selected a Customer Service account'; end if;

  select * into v_me
  from public.profiles
  where id = auth.uid() and role = 'agent' and is_active;
  if not found then raise exception 'Active agent profile not found'; end if;

  select * into v_target
  from public.profiles
  where id = v_settings.customer_service_profile_id
    and role = 'customer_service'
    and is_active;
  if not found then raise exception 'Customer Service account is no longer active'; end if;

  select * into v_item
  from public.work_items
  where id = p_work_item_id
  for update;
  if not found then raise exception 'Work item not found'; end if;
  if v_item.assigned_profile_id <> v_me.id then raise exception 'This work item is assigned to another employee'; end if;
  if v_item.status <> 'active' then raise exception 'Only active workload can be passed to Customer Service'; end if;
  if v_item.accepted_at is null then raise exception 'Accept the workload before passing it to Customer Service'; end if;
  if v_item.work_type not in ('activation', 'change') then raise exception 'Only Activations and Changes can be passed to Customer Service'; end if;

  v_combined_note := format(
    'Customer Service handoff by @%s. Reason: %s. Work passed: %s',
    v_me.username,
    btrim(p_reason),
    btrim(p_handoff_note)
  );
  v_log_source_id := coalesce(v_item.related_quote_source_work_item_id, v_item.id);

  update public.work_items
  set assigned_profile_id = v_target.id,
      assignment_method = 'customer_service'::public.assignment_method,
      assigned_at = now(),
      accepted_at = null,
      note = case
        when nullif(btrim(note), '') is null then v_combined_note
        else note || E'\n\n' || v_combined_note
      end,
      updated_at = now()
  where id = v_item.id
  returning * into v_item;

  -- This pass counts for the agent's pass metrics, but does not move the queue.
  insert into public.turn_events(
    rotation, action, actor_profile_id, previous_profile_id,
    next_profile_id, work_item_id, reason
  ) values (
    'workload', 'pass', v_me.id, v_me.id,
    v_target.id, v_item.id,
    format('Customer Service overflow — %s — %s', btrim(p_reason), btrim(p_handoff_note))
  );

  insert into public.work_item_events(
    source_work_item_id, event_type, actor_profile_id,
    assigned_profile_id, details, created_at
  ) values (
    v_log_source_id,
    'customer_service_handoff',
    v_me.id,
    v_target.id,
    jsonb_build_object(
      'service_work_item_id', v_item.id,
      'work_type', v_item.work_type,
      'reason', btrim(p_reason),
      'note', btrim(p_handoff_note),
      'customer_service_profile_id', v_target.id
    ),
    now()
  );

  if v_item.related_quote_source_work_item_id is not null then
    insert into public.quote_notes(source_work_item_id, author_profile_id, note)
    values (v_item.related_quote_source_work_item_id, v_me.id, v_combined_note);
  end if;

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, old_value, new_value, reason)
  values (
    v_me.id,
    'pass_workload_to_customer_service',
    'work_item',
    v_item.id,
    jsonb_build_object('assigned_profile_id', v_me.id),
    jsonb_build_object('assigned_profile_id', v_target.id, 'assignment_method', 'customer_service'),
    v_combined_note
  );

  return v_item;
end;
$$;

-- Existing-quote workload can be selected only from Pending Pricing or Sold.
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
  if p_work_type not in ('activation', 'change') then raise exception 'Additional Workload only accepts Activations or Changes'; end if;
  if p_related_quote_source_work_item_id is null then raise exception 'Select the existing quote this workload belongs to'; end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me
  from public.profiles
  where id = auth.uid() and role = 'agent' and is_active
  for update;
  if not found then raise exception 'Active agent profile not found'; end if;
  if v_me.availability <> 'available' or not v_me.workload_active then
    raise exception 'Set your status to Available before taking Additional Workload';
  end if;

  select q.customer_name, q.dealer_id, q.original_owner_profile_id, q.assigned_profile_id
  into v_customer_name, v_dealer_id, v_quote_owner_id, v_quote_assigned_id
  from (
    select
      p.customer_name,
      p.dealer_id,
      p.original_owner_profile_id,
      p.assigned_profile_id,
      p.price_sent_at as stage_at
    from public.pending_pricing_quotes p
    where p.source_work_item_id = p_related_quote_source_work_item_id

    union all

    select
      o.customer_name,
      o.dealer_id,
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
    raise exception 'Only Sold or Pending Pricing quotes can be selected for Additional Workload';
  end if;

  select * into v_state
  from public.rotation_state
  where kind = 'workload'
  for update;
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

  insert into public.work_item_events(
    source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at
  ) values (
    p_related_quote_source_work_item_id,
    case when p_work_type = 'activation' then 'activation' else 'change' end,
    v_me.id,
    coalesce(v_quote_assigned_id, v_me.id),
    jsonb_build_object(
      'service_work_item_id', v_item.id,
      'change_type', nullif(btrim(p_change_type), ''),
      'note', nullif(btrim(p_note), '')
    ),
    now()
  );

  perform public.add_quote_note_if_present(
    p_related_quote_source_work_item_id,
    v_me.id,
    p_note
  );

  if p_work_type = 'activation' then
    perform public.finalize_quote_as_sold_from_activation(
      p_related_quote_source_work_item_id,
      v_me.id
    );
  end if;

  v_next := public.next_eligible_profile('workload', v_me.workload_position);

  update public.rotation_state
  set current_profile_id = v_next,
      version = version + 1,
      updated_at = now(),
      updated_by = v_me.id
  where kind = 'workload';

  insert into public.turn_events(
    rotation, action, actor_profile_id, previous_profile_id, next_profile_id, work_item_id
  ) values (
    'workload', 'claim', v_me.id, v_me.id, v_next, v_item.id
  );

  return v_item;
end;
$$;

-- An agent may recover only their own previously Not Sold quote.
-- The original quote stays credited to that agent and the late activation is logged.
create or replace function public.convert_my_not_sold_quote_to_sold(
  p_outcome_id uuid,
  p_note text
)
returns public.quote_outcomes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles%rowtype;
  v_outcome public.quote_outcomes%rowtype;
  v_old_reason text;
  v_note text := nullif(btrim(p_note), '');
begin
  select * into v_me
  from public.profiles
  where id = auth.uid()
    and role = 'agent'
    and is_active;
  if not found then raise exception 'Active agent profile required'; end if;
  if v_note is null then raise exception 'A note explaining the late sale is required'; end if;

  select * into v_outcome
  from public.quote_outcomes
  where id = p_outcome_id
    and assigned_profile_id = v_me.id
    and decision = 'not_sold'
  for update;

  if not found then raise exception 'Your Not Sold quote was not found or has already been updated'; end if;

  v_old_reason := case
    when v_outcome.not_sold_reason = 'other' then coalesce(v_outcome.not_sold_reason_other, 'Other')
    else coalesce(v_outcome.not_sold_reason, 'Unknown')
  end;

  update public.quote_outcomes
  set decision = 'sold',
      not_sold_reason = null,
      not_sold_reason_other = null,
      finalized_at = now()
  where id = v_outcome.id
  returning * into v_outcome;

  insert into public.work_item_events(
    source_work_item_id, event_type, actor_profile_id,
    assigned_profile_id, details, created_at
  ) values (
    v_outcome.source_work_item_id,
    'activation',
    v_me.id,
    v_me.id,
    jsonb_build_object(
      'source', 'not_sold_recovery',
      'previous_decision', 'not_sold',
      'previous_reason', v_old_reason,
      'note', v_note
    ),
    now()
  );

  insert into public.quote_notes(source_work_item_id, author_profile_id, note)
  values (
    v_outcome.source_work_item_id,
    v_me.id,
    format(
      'Previously marked Not Sold and later sold by @%s. Previous reason: %s. Update: %s',
      v_me.username,
      v_old_reason,
      v_note
    )
  );

  insert into public.audit_log(
    actor_profile_id, action, entity_type, entity_id,
    old_value, new_value, reason
  ) values (
    v_me.id,
    'convert_not_sold_to_sold',
    'quote_outcome',
    v_outcome.id,
    jsonb_build_object('decision', 'not_sold', 'reason', v_old_reason),
    jsonb_build_object('decision', 'sold', 'finalized_at', v_outcome.finalized_at),
    v_note
  );

  return v_outcome;
end;
$$;

revoke execute on function public.convert_my_not_sold_quote_to_sold(uuid, text) from public, anon;
grant execute on function public.convert_my_not_sold_quote_to_sold(uuid, text) to authenticated;

grant execute on function public.add_quote_note(uuid, text) to authenticated;
grant execute on function public.pass_my_turn(public.rotation_kind, text) to authenticated;
grant execute on function public.accept_my_assigned_item(uuid) to authenticated;
grant execute on function public.complete_my_service_item(uuid, public.work_status) to authenticated;
grant execute on function public.manager_update_customer_service_overflow(boolean, uuid) to authenticated;
grant execute on function public.pass_workload_to_customer_service(uuid, text, text) to authenticated;
grant execute on function public.claim_linked_workload_turn(uuid, public.work_type, text, text) to authenticated;

commit;

select 'New Hope Work Desk v0.9.3 Customer Service and quote recovery installed' as status;
