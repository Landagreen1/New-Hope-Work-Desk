-- New Hope Work Desk v0.7.3
-- Manager-only quote deletion across Active, Pending Pricing, and Finalized quotes.
-- Run once in Supabase SQL Editor before deploying the v0.7.3 UI.

begin;

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
  if not public.is_manager() then
    raise exception 'Manager permission required';
  end if;

  if p_quote_id is null then
    raise exception 'Quote id is required';
  end if;

  if v_reason is null then
    raise exception 'Deletion reason is required';
  end if;

  if p_quote_stage = 'active' then
    select to_jsonb(w), w.id
      into v_old, v_source_work_item_id
    from public.work_items w
    where w.id = p_quote_id
      and w.work_type in ('new_quote', 'requote')
    for update;

    if v_old is null then
      raise exception 'Active quote not found';
    end if;

    delete from public.work_items
    where id = p_quote_id;

  elsif p_quote_stage = 'pending' then
    select to_jsonb(p), p.source_work_item_id
      into v_old, v_source_work_item_id
    from public.pending_pricing_quotes p
    where p.id = p_quote_id
    for update;

    if v_old is null then
      raise exception 'Pending Pricing quote not found';
    end if;

    delete from public.pending_pricing_quotes
    where id = p_quote_id;

  elsif p_quote_stage = 'finalized' then
    select to_jsonb(q), q.source_work_item_id
      into v_old, v_source_work_item_id
    from public.quote_outcomes q
    where q.id = p_quote_id
    for update;

    if v_old is null then
      raise exception 'Finalized quote not found';
    end if;

    delete from public.quote_outcomes
    where id = p_quote_id;

  else
    raise exception 'Invalid quote stage. Expected active, pending, or finalized';
  end if;

  -- Remove alerts that point to a quote record that no longer exists.
  delete from public.user_notifications
  where entity_id = p_quote_id
     or (v_source_work_item_id is not null and entity_id = v_source_work_item_id);

  -- Keep the lifecycle timestamps and turn history for auditability, but the quote
  -- itself is removed from operational views, performance, and reports.
  insert into public.audit_log(
    actor_profile_id,
    action,
    entity_type,
    entity_id,
    old_value,
    new_value,
    reason
  )
  values (
    auth.uid(),
    'quote_deleted',
    'quote',
    p_quote_id,
    v_old,
    jsonb_build_object(
      'stage', p_quote_stage,
      'source_work_item_id', v_source_work_item_id,
      'deleted_at', now()
    ),
    v_reason
  );
end;
$$;

grant execute on function public.manager_delete_quote(text, uuid, text) to authenticated;

insert into public.audit_log(actor_profile_id, action, entity_type, new_value, reason)
values (
  auth.uid(),
  'migration_v0_7_3_applied',
  'system',
  jsonb_build_object('version', '0.7.3'),
  'Manager-only quote deletion added'
);

commit;
