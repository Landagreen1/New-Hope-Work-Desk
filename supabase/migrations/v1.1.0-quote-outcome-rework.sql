-- v1.1.0 Quote Outcome Rework
-- Introduces a generalized bidirectional outcome change RPC.
-- finalized_at is the canonical reporting date; updated on every outcome change.

-- Extend event_type check to include 'outcome_change'.
alter table public.work_item_events
  drop constraint if exists work_item_events_event_type_check;

alter table public.work_item_events
  add constraint work_item_events_event_type_check check (
    event_type in (
      'created', 'assigned', 'accepted', 'reassigned', 'price_sent', 'sold',
      'not_sold', 'completed', 'cancelled', 'taken', 'activation', 'change',
      'payment', 'customer_service_handoff', 'created_from_cs_intake',
      'ringcentral_intake_claim_completed', 'outcome_change'
    )
  );

-- Generalized bidirectional outcome change RPC.
-- Handles sold → not_sold and not_sold → sold with full audit trail.
create or replace function public.change_quote_outcome(
  p_outcome_id uuid,
  p_new_decision public.quote_decision,
  p_not_sold_reason text default null,
  p_not_sold_reason_other text default null,
  p_note text default null
)
returns public.quote_outcomes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles%rowtype;
  v_outcome public.quote_outcomes%rowtype;
  v_previous_decision text;
  v_old_reason text;
  v_note text := nullif(btrim(p_note), '');
  v_reason text := nullif(btrim(p_not_sold_reason), '');
  v_reason_other text := nullif(btrim(p_not_sold_reason_other), '');
begin
  -- Validate: active agent profile
  select * into v_me
  from public.profiles
  where id = auth.uid()
    and role = 'agent'
    and is_active;
  if not found then raise exception 'Active agent profile required'; end if;

  -- Validate: note is non-empty
  if v_note is null then raise exception 'A note explaining the outcome change is required'; end if;

  -- Validate: outcome belongs to calling agent and lock for update
  select * into v_outcome
  from public.quote_outcomes
  where id = p_outcome_id
    and assigned_profile_id = v_me.id
  for update;
  if not found then raise exception 'Quote outcome not found or not assigned to you'; end if;

  -- Validate: new decision differs from current decision (no-op guard)
  if v_outcome.decision = p_new_decision then
    raise exception 'New decision is the same as the current decision';
  end if;

  -- Capture previous state for audit
  v_previous_decision := v_outcome.decision::text;
  v_old_reason := case
    when v_outcome.not_sold_reason = 'other' then coalesce(v_outcome.not_sold_reason_other, 'Other')
    else coalesce(v_outcome.not_sold_reason, 'Unknown')
  end;

  -- Direction-specific logic
  if p_new_decision = 'not_sold' then
    -- sold → not_sold: require valid not_sold_reason
    if v_reason is null then
      raise exception 'A not_sold_reason is required when changing to Not Sold';
    end if;

    update public.quote_outcomes
    set decision = 'not_sold',
        not_sold_reason = v_reason,
        not_sold_reason_other = v_reason_other,
        finalized_at = now()
    where id = v_outcome.id
    returning * into v_outcome;

  elsif p_new_decision = 'sold' then
    -- not_sold → sold: clear reason fields
    update public.quote_outcomes
    set decision = 'sold',
        not_sold_reason = null,
        not_sold_reason_other = null,
        finalized_at = now()
    where id = v_outcome.id
    returning * into v_outcome;
  end if;

  -- Insert work_item_events row
  insert into public.work_item_events(
    source_work_item_id, event_type, actor_profile_id,
    assigned_profile_id, details, created_at
  ) values (
    v_outcome.source_work_item_id,
    'outcome_change',
    v_me.id,
    v_me.id,
    jsonb_build_object(
      'previous_decision', v_previous_decision,
      'new_decision', p_new_decision::text,
      'reason', coalesce(v_reason, v_old_reason),
      'note', v_note
    ),
    now()
  );

  -- Insert audit_log row
  insert into public.audit_log(
    actor_profile_id, action, entity_type, entity_id,
    old_value, new_value, reason
  ) values (
    v_me.id,
    'change_quote_outcome',
    'quote_outcome',
    v_outcome.id,
    jsonb_build_object('decision', v_previous_decision, 'reason', v_old_reason),
    jsonb_build_object('decision', p_new_decision::text, 'finalized_at', v_outcome.finalized_at),
    v_note
  );

  -- Insert quote_notes row documenting the change
  insert into public.quote_notes(source_work_item_id, author_profile_id, note)
  values (
    v_outcome.source_work_item_id,
    v_me.id,
    format(
      'Outcome changed from %s to %s by @%s. %s',
      v_previous_decision,
      p_new_decision::text,
      v_me.username,
      v_note
    )
  );

  return v_outcome;
end;
$$;

revoke execute on function public.change_quote_outcome(uuid, public.quote_decision, text, text, text) from public, anon;
grant execute on function public.change_quote_outcome(uuid, public.quote_decision, text, text, text) to authenticated;

-- Rewrite convert_my_not_sold_quote_to_sold as a thin wrapper around change_quote_outcome.
-- Maintains backward compatibility: existing callers continue to work identically.
create or replace function public.convert_my_not_sold_quote_to_sold(
  p_outcome_id uuid,
  p_note text
)
returns public.quote_outcomes
language plpgsql
security definer
set search_path = public
as $$
begin
  return change_quote_outcome(p_outcome_id, 'sold'::public.quote_decision, null, null, p_note);
end;
$$;

revoke execute on function public.convert_my_not_sold_quote_to_sold(uuid, text) from public, anon;
grant execute on function public.convert_my_not_sold_quote_to_sold(uuid, text) to authenticated;
