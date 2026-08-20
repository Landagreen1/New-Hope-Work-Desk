-- New Hope Work Desk v1.12.13 — Add intake_created_by to quote lifecycle tables
--
-- Problem: When a CS intake is converted into a quote, the identity of the
--   Customer Service agent who originally created the intake form is only stored
--   in work_item_events.details->>'csr_profile_id' (JSON). Once the work_item is
--   deleted during finalization, tracing back to the intake creator requires
--   forensic multi-table joins. This makes simple lookups like "who created this
--   intake?" unreasonably hard.
--
-- Solution: Add a nullable `intake_created_by` column to work_items,
--   pending_pricing_quotes, and quote_outcomes. Populate it during
--   cs_intake_convert. Carry it through the lifecycle functions that move rows
--   between these tables.
--
-- Backfill: Populate existing rows from work_item_events.details->>'csr_profile_id'.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Add intake_created_by column to all three lifecycle tables
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.work_items
  add column if not exists intake_created_by uuid references public.profiles(id);

alter table public.pending_pricing_quotes
  add column if not exists intake_created_by uuid references public.profiles(id);

alter table public.quote_outcomes
  add column if not exists intake_created_by uuid references public.profiles(id);

comment on column public.work_items.intake_created_by is
  'The CS agent who originally created the intake form that was converted into this quote. NULL for quotes not originating from a CS intake.';
comment on column public.pending_pricing_quotes.intake_created_by is
  'The CS agent who originally created the intake form. Carried from work_items when quote moves to pending pricing.';
comment on column public.quote_outcomes.intake_created_by is
  'The CS agent who originally created the intake form. Carried through the quote lifecycle from work_items.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Backfill existing work_items from work_item_events details JSON
-- ═══════════════════════════════════════════════════════════════════════════════

update public.work_items wi
set intake_created_by = (e.details->>'csr_profile_id')::uuid
from public.work_item_events e
where e.source_work_item_id = wi.id
  and e.event_type = 'created_from_cs_intake'
  and e.details->>'csr_profile_id' is not null
  and wi.intake_created_by is null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Backfill pending_pricing_quotes from work_item_events details JSON
-- ═══════════════════════════════════════════════════════════════════════════════

update public.pending_pricing_quotes pp
set intake_created_by = (e.details->>'csr_profile_id')::uuid
from public.work_item_events e
where e.source_work_item_id = pp.source_work_item_id
  and e.event_type = 'created_from_cs_intake'
  and e.details->>'csr_profile_id' is not null
  and pp.intake_created_by is null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Backfill quote_outcomes from work_item_events details JSON
-- ═══════════════════════════════════════════════════════════════════════════════

update public.quote_outcomes qo
set intake_created_by = (e.details->>'csr_profile_id')::uuid
from public.work_item_events e
where e.source_work_item_id = qo.source_work_item_id
  and e.event_type = 'created_from_cs_intake'
  and e.details->>'csr_profile_id' is not null
  and qo.intake_created_by is null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Rewrite cs_intake_convert to populate intake_created_by
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.cs_intake_convert(p_submission_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cs_intake_submissions%rowtype;
  v_work_item_id uuid;
  v_customer_name text;
  v_agent_name text;
  v_details jsonb;
begin
  select * into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then raise exception 'Intake not found.'; end if;

  -- Idempotency: if already converted with a linked work_item, return it.
  if v_row.status::text = 'converted' and v_row.work_item_id is not null then
    return v_row.work_item_id;
  end if;

  if v_row.status::text <> 'claimed' or v_row.claimed_by is null then
    raise exception 'Claim or assign this intake first.';
  end if;

  -- Allow: managers, super_admins, sales_supervisors, or the agent who claimed it
  if not public.can_manage_sales() and v_row.claimed_by <> auth.uid() then
    raise exception 'This intake belongs to another Sales Agent.';
  end if;

  v_customer_name := coalesce(nullif(trim(v_row.business_name), ''), trim(v_row.insured_first_name || ' ' || v_row.insured_last_name));

  -- Build details in a flat structure matching IntakeDataDisplay component props.
  v_details := jsonb_build_object(
    'intake_id', v_row.id,
    'csr_profile_id', v_row.created_by,
    'line_of_business', v_row.line_of_business::text,
    'quote_kind', v_row.quote_kind,
    'desired_coverage', v_row.desired_coverage,
    'business_name', v_row.business_name,
    'dot_number', v_row.dot_number,
    'business_type', v_row.business_type,
    'years_in_business', v_row.years_in_business,
    'operating_radius_miles', v_row.operating_radius_miles,
    'insured_first_name', v_row.insured_first_name,
    'insured_last_name', v_row.insured_last_name,
    'insured_dob', case
      when v_row.insured_dob is not null then
        to_char(v_row.insured_dob, 'FMMM/FMDD/YYYY')
      else null
    end,
    'insured_phone_primary', v_row.insured_phone_primary,
    'insured_email', v_row.insured_email,
    'addr_street', v_row.addr_street,
    'addr_unit', v_row.addr_unit,
    'addr_city', v_row.addr_city,
    'addr_state', v_row.addr_state,
    'addr_zip', v_row.addr_zip,
    'current_carrier', v_row.current_carrier,
    'current_policy_number', v_row.current_policy_number,
    'current_premium', v_row.current_premium,
    'current_expiration', v_row.current_expiration,
    'csr_notes', v_row.csr_notes,
    'drivers', (select coalesce(jsonb_agg(
      jsonb_build_object(
        'first_name', d.first_name,
        'last_name', d.last_name,
        'dob', case
          when d.dob is not null then to_char(d.dob, 'FMMM/FMDD/YYYY')
          else null
        end,
        'license_number', d.license_number,
        'license_state', d.license_state,
        'years_licensed', d.years_licensed,
        'sr22_required', d.sr22_required
      ) order by d.position
    ), '[]'::jsonb) from public.cs_intake_drivers d where d.submission_id = v_row.id),
    'vehicles', (select coalesce(jsonb_agg(
      jsonb_build_object(
        'year', v.year,
        'make', v.make,
        'model', v.model,
        'vin', v.vin,
        'usage', v.usage,
        'annual_mileage', v.annual_mileage
      ) order by v.position
    ), '[]'::jsonb) from public.cs_intake_vehicles v where v.submission_id = v_row.id),
    'owners', (select coalesce(jsonb_agg(
      jsonb_build_object(
        'first_name', o.first_name,
        'middle_name', o.middle_name,
        'last_name', o.last_name,
        'dob', case
          when o.dob is not null then to_char(o.dob, 'FMMM/FMDD/YYYY')
          else null
        end,
        'phone', o.phone,
        'email', o.email,
        'ownership_percentage', o.ownership_percentage
      ) order by o.position
    ), '[]'::jsonb) from public.cs_intake_owners o where o.submission_id = v_row.id)
  );

  if v_row.quote_kind = 'requote' then
    insert into public.work_items (
      customer_name, dealer_id, salesperson_id, work_type,
      original_owner_profile_id, assigned_profile_id, assignment_method,
      status, note, received_through, created_by, assigned_at, intake_created_by
    ) values (
      v_customer_name, v_row.dealer_id, v_row.salesperson_id, 'requote',
      v_row.claimed_by, v_row.claimed_by, 'manual_quote',
      'active', 'Created from Customer Service structured intake', 'cs_intake', v_row.claimed_by, now(),
      v_row.created_by
    ) returning id into v_work_item_id;
  else
    insert into public.work_items (
      customer_name, dealer_id, salesperson_id, work_type,
      original_owner_profile_id, assigned_profile_id, assignment_method,
      status, note, received_through, created_by, assigned_at, intake_created_by
    ) values (
      v_customer_name, v_row.dealer_id, v_row.salesperson_id, 'new_quote',
      v_row.claimed_by, v_row.claimed_by, 'manual_quote',
      'active', 'Created from Customer Service structured intake', 'cs_intake', v_row.claimed_by, now(),
      v_row.created_by
    ) returning id into v_work_item_id;
  end if;

  insert into public.work_item_events (
    source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details
  ) values (
    v_work_item_id, 'created_from_cs_intake', auth.uid(), v_row.claimed_by, v_details
  );

  update public.cs_intake_submissions
  set status = 'converted', work_item_id = v_work_item_id, converted_at = now(), updated_at = now()
  where id = p_submission_id;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (p_submission_id, auth.uid(), 'converted', jsonb_build_object('work_item_id', v_work_item_id, 'sales_owner', v_row.claimed_by));

  if v_row.source_renewal_id is not null then
    update public.renewal_records
    set requote_work_item_id = v_work_item_id,
        requote_intake_id = p_submission_id,
        status = 'requote_sent',
        requote_sent_at = coalesce(requote_sent_at, now()),
        updated_at = now()
    where id = v_row.source_renewal_id;

    insert into public.renewal_events (record_id, actor_id, event_type, detail)
    values (v_row.source_renewal_id, auth.uid(), 'requote_quote_created', jsonb_build_object('intake_id', p_submission_id, 'work_item_id', v_work_item_id));
  end if;

  select display_name into v_agent_name from public.profiles where id = v_row.claimed_by;
  insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (v_row.created_by, 'assignment', 'Intake converted to a quote', coalesce(v_agent_name, 'Sales') || ' created the quote. Your intake credit was preserved.', 'work_item', v_work_item_id);

  return v_work_item_id;
end;
$$;

grant execute on function public.cs_intake_convert(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. Rewrite move_my_quote_to_pending_pricing to carry intake_created_by
-- ═══════════════════════════════════════════════════════════════════════════════

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
    received_through, note, quote_created_at, assigned_at, accepted_at, price_sent_at,
    intake_created_by
  ) values (
    v_item.id, v_item.customer_name, v_item.dealer_id, v_item.work_type,
    v_item.original_owner_profile_id, v_item.assigned_profile_id, v_item.assignment_method,
    v_item.received_through, v_item.note, v_item.created_at, coalesce(v_item.assigned_at, v_item.created_at), v_item.accepted_at, now(),
    v_item.intake_created_by
  ) returning * into v_pending;

  delete from public.work_items where id = v_item.id;

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, new_value)
  values (auth.uid(), 'quote_moved_to_pending_pricing', 'pending_pricing_quote', v_pending.id, to_jsonb(v_pending));

  return v_pending;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. Rewrite finalize_my_active_quote to carry intake_created_by
-- ═══════════════════════════════════════════════════════════════════════════════

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
    decision, not_sold_reason, not_sold_reason_other, finalized_at,
    salesperson_id, intake_created_by
  ) values (
    v_item.id, v_item.customer_name, v_item.dealer_id, v_item.work_type,
    v_item.original_owner_profile_id, v_item.assigned_profile_id, v_item.assignment_method,
    v_item.received_through, v_item.created_at, coalesce(v_item.assigned_at, v_item.created_at), v_item.accepted_at,
    p_decision,
    case when p_decision = 'not_sold' then p_not_sold_reason else null end,
    case when p_decision = 'not_sold' and p_not_sold_reason = 'other' then nullif(trim(p_not_sold_reason_other), '') else null end,
    now(),
    v_item.salesperson_id, v_item.intake_created_by
  ) returning * into v_outcome;

  delete from public.work_items where id = v_item.id;

  insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details)
  values (v_item.id, p_decision::text, auth.uid(), v_item.assigned_profile_id,
    jsonb_build_object('reason', p_not_sold_reason, 'reason_other', p_not_sold_reason_other));

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, new_value)
  values (auth.uid(), 'quote_finalized_' || p_decision::text, 'quote_outcome', v_outcome.id, to_jsonb(v_outcome));

  return v_outcome;
end;
$$;

grant execute on function public.finalize_my_active_quote(uuid, public.quote_decision, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. Rewrite finalize_pending_pricing_quote to carry intake_created_by
-- ═══════════════════════════════════════════════════════════════════════════════

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
  if not public.is_agent() then raise exception 'Agent permission required'; end if;
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
    and assigned_profile_id = auth.uid()
  for update;

  if not found then raise exception 'Pending pricing quote not found or not available to you'; end if;

  insert into public.quote_outcomes(
    source_work_item_id, customer_name, dealer_id, work_type,
    original_owner_profile_id, assigned_profile_id, assignment_method,
    received_through, quote_created_at, assigned_at, accepted_at,
    price_sent_at, decision, not_sold_reason, not_sold_reason_other, finalized_at,
    salesperson_id, intake_created_by
  ) values (
    v_pending.source_work_item_id, v_pending.customer_name, v_pending.dealer_id, v_pending.work_type,
    v_pending.original_owner_profile_id, v_pending.assigned_profile_id, v_pending.assignment_method,
    v_pending.received_through, v_pending.quote_created_at, coalesce(v_pending.assigned_at, v_pending.quote_created_at), coalesce(v_pending.accepted_at, v_pending.quote_created_at),
    v_pending.price_sent_at, p_decision,
    case when p_decision = 'not_sold' then p_not_sold_reason else null end,
    case when p_decision = 'not_sold' and p_not_sold_reason = 'other' then nullif(trim(p_not_sold_reason_other), '') else null end,
    now(),
    v_pending.salesperson_id, v_pending.intake_created_by
  ) returning * into v_outcome;

  delete from public.pending_pricing_quotes where id = v_pending.id;

  insert into public.work_item_events(source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details)
  values (v_pending.source_work_item_id, p_decision::text, auth.uid(), v_pending.assigned_profile_id,
    jsonb_build_object('reason', p_not_sold_reason, 'reason_other', p_not_sold_reason_other, 'from_pending_pricing', true));

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, new_value)
  values (auth.uid(), 'quote_finalized_' || p_decision::text, 'quote_outcome', v_outcome.id, to_jsonb(v_outcome));

  return v_outcome;
end;
$$;

grant execute on function public.finalize_pending_pricing_quote(uuid, public.quote_decision, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. Rewrite finalize_quote_as_sold_from_activation to carry intake_created_by
-- ═══════════════════════════════════════════════════════════════════════════════

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
  -- Try active work_items first
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
      decision, not_sold_reason, not_sold_reason_other, finalized_at,
      salesperson_id, intake_created_by
    ) values (
      v_active.id, v_active.customer_name, v_active.dealer_id, v_active.work_type,
      v_active.original_owner_profile_id, v_active.assigned_profile_id, v_active.assignment_method,
      v_active.received_through, v_active.created_at, coalesce(v_active.assigned_at, v_active.created_at), coalesce(v_active.accepted_at, v_active.created_at),
      'sold', null, null, now(),
      v_active.salesperson_id, v_active.intake_created_by
    ) returning * into v_outcome;

    return v_outcome;
  end if;

  -- Try pending_pricing_quotes
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
      price_sent_at, decision, not_sold_reason, not_sold_reason_other, finalized_at,
      salesperson_id, intake_created_by
    ) values (
      v_pending.source_work_item_id, v_pending.customer_name, v_pending.dealer_id, v_pending.work_type,
      v_pending.original_owner_profile_id, v_pending.assigned_profile_id, v_pending.assignment_method,
      v_pending.received_through, v_pending.quote_created_at, coalesce(v_pending.assigned_at, v_pending.quote_created_at), coalesce(v_pending.accepted_at, v_pending.quote_created_at),
      v_pending.price_sent_at, 'sold', null, null, now(),
      v_pending.salesperson_id, v_pending.intake_created_by
    ) returning * into v_outcome;

    return v_outcome;
  end if;

  -- Try existing outcome (re-finalization as sold)
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
      price_sent_at, decision, not_sold_reason, not_sold_reason_other, finalized_at,
      salesperson_id, intake_created_by
    ) values (
      v_existing.source_work_item_id, v_existing.customer_name, v_existing.dealer_id, v_existing.work_type,
      v_existing.original_owner_profile_id, v_existing.assigned_profile_id, v_existing.assignment_method,
      v_existing.received_through, v_existing.quote_created_at, v_existing.assigned_at, v_existing.accepted_at,
      v_existing.price_sent_at, 'sold', null, null, now(),
      v_existing.salesperson_id, v_existing.intake_created_by
    ) returning * into v_outcome;

    return v_outcome;
  end if;

  raise exception 'No active, pending, or finalized quote found for source_work_item_id %', p_source_work_item_id;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. Verification
-- ═══════════════════════════════════════════════════════════════════════════════

do $verify$
declare
  v_count integer;
begin
  -- Verify columns exist
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'work_items' and column_name = 'intake_created_by'
  ) then
    raise exception 'work_items.intake_created_by column not found';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pending_pricing_quotes' and column_name = 'intake_created_by'
  ) then
    raise exception 'pending_pricing_quotes.intake_created_by column not found';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'quote_outcomes' and column_name = 'intake_created_by'
  ) then
    raise exception 'quote_outcomes.intake_created_by column not found';
  end if;

  -- Verify cs_intake_convert function references the new column
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cs_intake_convert'
      and pg_get_functiondef(p.oid) like '%intake_created_by%'
  ) then
    raise exception 'cs_intake_convert does not reference intake_created_by';
  end if;

  -- Report backfill counts
  select count(*) into v_count from public.quote_outcomes where intake_created_by is not null;
  raise notice 'v1.12.13: Backfilled % quote_outcomes rows with intake_created_by', v_count;

  select count(*) into v_count from public.work_items where intake_created_by is not null;
  raise notice 'v1.12.13: Backfilled % work_items rows with intake_created_by', v_count;

  select count(*) into v_count from public.pending_pricing_quotes where intake_created_by is not null;
  raise notice 'v1.12.13: Backfilled % pending_pricing_quotes rows with intake_created_by', v_count;
end
$verify$;

commit;
