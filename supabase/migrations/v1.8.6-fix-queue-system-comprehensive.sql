-- New Hope Work Desk v1.8.6
-- Comprehensive queue system fixes
--
-- Issues addressed:
--   1. line_of_business CHECK constraint missing motorcycle, boat, trailer, renters
--   2. cs_intake_submit rejects new personal-queue LOBs (motorcycle, boat, trailer, renters)
--   3. cs_intake_claim (general non-RC) function definition not in repo — define it properly
--   4. cs_intake_manager_assign only accepts role='agent' targets
--   5. cs_intake_submit role check too restrictive for supervisor roles
--   6. cs_intake_convert role check too restrictive for sales_supervisor
--   7. cs_intake_return role check too restrictive for sales_supervisor

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. EXPAND line_of_business CHECK CONSTRAINT to include new personal LOBs
-- ═══════════════════════════════════════════════════════════════════════════════

do $$
begin
  execute 'alter table public.cs_intake_submissions drop constraint if exists cs_intake_submissions_line_of_business_check';
exception when others then null;
end $$;

alter table public.cs_intake_submissions
  add constraint cs_intake_submissions_line_of_business_check
  check (line_of_business::text in (
    'auto', 'personal_auto', 'commercial_auto',
    'trucking', 'commercial_gl', 'homeowners', 'non_owners',
    'motorcycle', 'boat', 'trailer', 'renters'
  ));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. FIX cs_intake_submit to accept new personal-queue LOBs
--    motorcycle, boat, trailer, renters should all go through this path
--    (not cs_intake_submit_commercial which is for homeowners/trucking/commercial_gl)
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.cs_intake_submit(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cs_intake_submissions%rowtype;
  v_has_salespeople boolean;
begin
  select * into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then raise exception 'Intake not found.'; end if;

  -- Allow the creator, managers, super_admins, and supervisors to submit
  if v_row.created_by <> auth.uid()
     and public.nhwd_role() not in ('manager')
     and not public.can_manage_customer_service()
     and not public.can_manage_sales() then
    raise exception 'You cannot submit this intake.';
  end if;

  if v_row.status::text not in ('draft', 'returned') then
    raise exception 'Only Draft or Returned intakes can be submitted.';
  end if;

  -- This function handles personal-queue LOBs only.
  -- Commercial-routed LOBs (homeowners, trucking, commercial_gl) use cs_intake_submit_commercial.
  if v_row.line_of_business::text not in (
    'auto', 'personal_auto', 'commercial_auto', 'non_owners',
    'motorcycle', 'boat', 'trailer', 'renters'
  ) then
    raise exception 'Use cs_intake_submit_commercial for homeowners, trucking, and commercial GL intakes.';
  end if;

  -- Common validation: name, DOB, phone, address
  if nullif(trim(v_row.insured_first_name), '') is null
     or nullif(trim(v_row.insured_last_name), '') is null
     or v_row.insured_dob is null
     or nullif(trim(v_row.insured_phone_primary), '') is null
     or nullif(trim(v_row.addr_street), '') is null
     or nullif(trim(v_row.addr_city), '') is null
     or nullif(trim(v_row.addr_state), '') is null
     or nullif(trim(v_row.addr_zip), '') is null then
    raise exception 'Name, DOB, phone, and full address are required.';
  end if;

  -- Non-owners: only need SR-22 filing state
  if v_row.line_of_business::text = 'non_owners' then
    if nullif(trim(v_row.sr22_filing_state), '') is null then
      raise exception 'SR-22 filing state is required for Non-Owners.';
    end if;

  -- Motorcycle: basic vehicle info validation
  elsif v_row.line_of_business::text = 'motorcycle' then
    if nullif(trim(v_row.moto_year), '') is null
       or nullif(trim(v_row.moto_make), '') is null
       or nullif(trim(v_row.moto_model), '') is null then
      raise exception 'Motorcycle year, make, and model are required.';
    end if;

  -- Boat: basic vessel info validation
  elsif v_row.line_of_business::text = 'boat' then
    if nullif(trim(v_row.boat_year), '') is null
       or nullif(trim(v_row.boat_make), '') is null
       or nullif(trim(v_row.boat_type), '') is null then
      raise exception 'Boat year, make, and type are required.';
    end if;

  -- Trailer/Mobile Home: basic info validation
  elsif v_row.line_of_business::text = 'trailer' then
    if nullif(trim(v_row.trailer_year), '') is null
       or nullif(trim(v_row.trailer_type), '') is null then
      raise exception 'Trailer year and type are required.';
    end if;

  -- Renters: property address required
  elsif v_row.line_of_business::text = 'renters' then
    if nullif(trim(v_row.renters_property_address), '') is null
       or nullif(trim(v_row.renters_city), '') is null
       or nullif(trim(v_row.renters_state), '') is null
       or nullif(trim(v_row.renters_zip), '') is null then
      raise exception 'Rental property address (street, city, state, zip) is required.';
    end if;

  -- Auto types need coverage selection, drivers, vehicles
  else
    if v_row.desired_coverage is null then
      raise exception 'Choose Liability Only, Full Coverage, or Unsure.';
    end if;

    if v_row.line_of_business::text = 'commercial_auto' then
      if nullif(trim(v_row.business_name), '') is null then raise exception 'Business name is required.'; end if;
      if nullif(trim(v_row.business_type), '') is null then raise exception 'Type of work is required.'; end if;
      if not coalesce(v_row.dot_not_applicable, false) and nullif(trim(v_row.dot_number), '') is null then
        raise exception 'Enter the DOT number or mark DOT not applicable.';
      end if;
    end if;

    if not exists (
      select 1 from public.cs_intake_drivers d
      where d.submission_id = p_submission_id
    ) then raise exception 'Add at least one person or driver.'; end if;

    if exists (
      select 1 from public.cs_intake_drivers d
      where d.submission_id = p_submission_id
        and (
          nullif(trim(d.first_name), '') is null
          or nullif(trim(d.last_name), '') is null
          or d.dob is null
          or nullif(trim(d.license_number), '') is null
          or nullif(trim(d.license_state), '') is null
        )
    ) then raise exception 'Complete the name, DOB, license/ID number, and issuing state for every person.'; end if;

    if not exists (
      select 1 from public.cs_intake_vehicles v
      where v.submission_id = p_submission_id
    ) then raise exception 'Add at least one vehicle.'; end if;

    if exists (
      select 1 from public.cs_intake_vehicles v
      where v.submission_id = p_submission_id
        and (
          v.year is null
          or nullif(trim(v.make), '') is null
          or nullif(trim(v.model), '') is null
          or (nullif(trim(v.vin), '') is null and not coalesce(v.vin_pending, false))
        )
    ) then raise exception 'Complete year, make, model, and VIN (or VIN pending) for every vehicle.'; end if;
  end if;

  -- Dealer/salesperson validation (applies to all personal-queue LOBs)
  if v_row.dealer_id is not null then
    select exists (
      select 1 from public.dealer_salespeople dsp
      where dsp.dealer_id = v_row.dealer_id and dsp.is_active
    ) into v_has_salespeople;

    if v_has_salespeople and v_row.salesperson_id is null then
      raise exception 'Choose the salesperson for this dealer.';
    end if;
    if v_row.salesperson_id is not null and not exists (
      select 1 from public.dealer_salespeople dsp
      where dsp.id = v_row.salesperson_id and dsp.dealer_id = v_row.dealer_id and dsp.is_active
    ) then
      raise exception 'Invalid salesperson for this dealer.';
    end if;
  end if;

  -- Mark as submitted
  update public.cs_intake_submissions
  set status = 'submitted', submitted_at = now(), updated_at = now()
  where id = p_submission_id;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (p_submission_id, auth.uid(), 'submitted', jsonb_build_object(
    'line_of_business', v_row.line_of_business::text,
    'quote_kind', v_row.quote_kind,
    'priority', v_row.priority::text
  ));

  -- Notify all active sales agents
  insert into public.user_notifications (
    recipient_profile_id, notification_type, title, message, entity_type, entity_id
  )
  select p.id, 'assignment', 'New Customer Service quote intake',
         coalesce(nullif(v_row.business_name, ''), trim(v_row.insured_first_name || ' ' || v_row.insured_last_name)) ||
         ' is ready in the Sales Intake Queue.',
         'cs_intake', p_submission_id
  from public.profiles p
  where p.is_active and p.role::text = 'agent';

  if v_row.source_renewal_id is not null then
    update public.renewal_records
    set status = 'requote_sent',
        requote_intake_id = p_submission_id,
        requote_sent_at = now(),
        updated_at = now()
    where id = v_row.source_renewal_id;

    insert into public.renewal_events (record_id, actor_id, event_type, detail)
    values (v_row.source_renewal_id, auth.uid(), 'requote_intake_submitted', jsonb_build_object('intake_id', p_submission_id));
  end if;
end;
$$;

grant execute on function public.cs_intake_submit(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. DEFINE cs_intake_claim (general non-RC claim for agents)
--    This function was applied directly to production but was never captured in
--    a migration file. We define it here with proper role parity.
--
--    Behavior: simple claim — sets status='claimed', advances nothing.
--    The agent then uses cs_intake_convert to create the quote separately.
-- ═══════════════════════════════════════════════════════════════════════════════

drop function if exists public.cs_intake_claim(uuid);

create or replace function public.cs_intake_claim(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cs_intake_submissions%rowtype;
  v_role text;
begin
  v_role := public.nhwd_role();

  -- Agents and sales_supervisors can claim intakes from the queue
  if v_role not in ('agent', 'manager', 'sales_supervisor') then
    raise exception 'Sales Agent or Manager access required to claim intakes.';
  end if;

  select * into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then raise exception 'Intake not found.'; end if;
  if v_row.status::text <> 'submitted' then
    raise exception 'This intake is no longer available to claim.';
  end if;

  update public.cs_intake_submissions
  set status = 'claimed',
      claimed_by = auth.uid(),
      claimed_at = now(),
      updated_at = now()
  where id = p_submission_id
    and status::text = 'submitted';

  if not found then
    raise exception 'Another agent claimed this intake first.';
  end if;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (p_submission_id, auth.uid(), 'claimed', jsonb_build_object('role', v_role));
end;
$$;

grant execute on function public.cs_intake_claim(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. FIX cs_intake_manager_assign to accept broader role targets
--    Managers should be able to assign to agents AND sales_supervisors
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.cs_intake_manager_assign(
  p_submission_id uuid,
  p_agent_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creator uuid;
  v_name text;
begin
  -- Managers, super_admins, sales_supervisors, and CS supervisors can assign
  if not public.can_manage_sales() and not public.can_manage_customer_service() then
    raise exception 'Manager or Supervisor access required.';
  end if;

  -- Target must be an active user who handles sales quotes
  if not exists (
    select 1 from public.profiles
    where id = p_agent_id
      and is_active
      and role::text in ('agent', 'sales_supervisor')
  ) then
    raise exception 'Choose an active Sales Agent or Sales Supervisor.';
  end if;

  update public.cs_intake_submissions
  set status = 'claimed',
      claimed_by = p_agent_id,
      claimed_at = now(),
      intake_channel = 'manual',
      updated_at = now()
  where id = p_submission_id
    and status::text = 'submitted'
  returning created_by into v_creator;

  if not found then
    raise exception 'This intake is no longer available for assignment.';
  end if;

  select display_name into v_name from public.profiles where id = p_agent_id;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (
    p_submission_id,
    auth.uid(),
    'manager_assigned',
    jsonb_build_object(
      'assigned_to', p_agent_id,
      'assigned_name', v_name,
      'intake_channel', 'manual'
    )
  );

  insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (p_agent_id, 'assignment', 'Quote intake assigned to you', 'A Manager assigned a Customer Service intake. Review it and create the quote.', 'cs_intake', p_submission_id);

  insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (v_creator, 'assignment', 'Your intake was assigned', 'Sales Agent ' || coalesce(v_name, '') || ' received your quote intake.', 'cs_intake', p_submission_id);
end;
$$;

grant execute on function public.cs_intake_manager_assign(uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. FIX cs_intake_convert to include sales_supervisor parity
--    Sales supervisors should be able to convert intakes they claimed
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

  -- Allow: managers, sales_supervisors, or the agent who claimed it
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
    'insured_dob', v_row.insured_dob,
    'insured_phone_primary', v_row.insured_phone_primary,
    'insured_email', v_row.insured_email,
    'addr_street', v_row.addr_street,
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
        'dob', d.dob,
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
    ), '[]'::jsonb) from public.cs_intake_vehicles v where v.submission_id = v_row.id)
  );

  if v_row.quote_kind = 'requote' then
    insert into public.work_items (
      customer_name, dealer_id, salesperson_id, work_type,
      original_owner_profile_id, assigned_profile_id, assignment_method,
      status, note, received_through, created_by, assigned_at
    ) values (
      v_customer_name, v_row.dealer_id, v_row.salesperson_id, 'requote',
      v_row.claimed_by, v_row.claimed_by, 'manual_quote',
      'active', 'Created from Customer Service structured intake', 'cs_intake', v_row.claimed_by, now()
    ) returning id into v_work_item_id;
  else
    insert into public.work_items (
      customer_name, dealer_id, salesperson_id, work_type,
      original_owner_profile_id, assigned_profile_id, assignment_method,
      status, note, received_through, created_by, assigned_at
    ) values (
      v_customer_name, v_row.dealer_id, v_row.salesperson_id, 'new_quote',
      v_row.claimed_by, v_row.claimed_by, 'manual_quote',
      'active', 'Created from Customer Service structured intake', 'cs_intake', v_row.claimed_by, now()
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
-- 6. FIX cs_intake_return to include sales_supervisor parity
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.cs_intake_return(p_submission_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creator uuid;
begin
  if nullif(trim(p_reason), '') is null then raise exception 'A return reason is required.'; end if;

  update public.cs_intake_submissions
  set status = 'returned',
      return_reason = trim(p_reason),
      claimed_by = null,
      claimed_at = null,
      updated_at = now()
  where id = p_submission_id
    and status::text in ('submitted', 'claimed')
    and (
      public.can_manage_sales()
      or public.can_manage_customer_service()
      or claimed_by = auth.uid()
      or status::text = 'submitted'
    )
  returning created_by into v_creator;

  if not found then raise exception 'You cannot return this intake.'; end if;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (p_submission_id, auth.uid(), 'returned', jsonb_build_object('reason', trim(p_reason)));

  insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (v_creator, 'assignment', 'Quote intake returned', trim(p_reason), 'cs_intake', p_submission_id);
end;
$$;

grant execute on function public.cs_intake_return(uuid, text) to authenticated;

commit;
