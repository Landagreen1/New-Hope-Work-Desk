-- v1.6.0 Unified Quote Intake — Expanded Line of Business
--
-- Adds new customer types to the intake form:
--   personal_auto, commercial_auto, non_owners → Personal Sales Queue (work_items)
--   homeowners, trucking, commercial_gl → Commercial Board (commercial_quotes cards)
--
-- Changes:
--   1. Expand line_of_business constraint to include new LOBs
--   2. Add LOB-specific columns to cs_intake_submissions
--   3. Create cs_intake_submit_commercial RPC for commercial-routed intakes

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. EXPAND line_of_business CONSTRAINT
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop old constraint (name may vary across migration versions)
do $$
begin
  -- Try known constraint names
  execute 'alter table public.cs_intake_submissions drop constraint if exists cs_intake_submissions_line_of_business_check';
  execute 'alter table public.cs_intake_submissions drop constraint if exists cs_intake_submissions_lob_check';
exception when others then null;
end $$;

alter table public.cs_intake_submissions
  add constraint cs_intake_submissions_line_of_business_check
  check (line_of_business::text in (
    'auto', 'personal_auto', 'commercial_auto',
    'trucking', 'commercial_gl', 'homeowners', 'non_owners'
  ));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ADD LOB-SPECIFIC COLUMNS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Trucking fields
alter table public.cs_intake_submissions add column if not exists mc_number varchar(20);
alter table public.cs_intake_submissions add column if not exists mcs150_date date;
alter table public.cs_intake_submissions add column if not exists cargo_type varchar(100);
alter table public.cs_intake_submissions add column if not exists power_unit_count integer;

-- Commercial GL fields
alter table public.cs_intake_submissions add column if not exists ein varchar(20);
alter table public.cs_intake_submissions add column if not exists states_of_operation text;
alter table public.cs_intake_submissions add column if not exists employee_count integer;
alter table public.cs_intake_submissions add column if not exists annual_payroll numeric(12,2);
alter table public.cs_intake_submissions add column if not exists coverage_types_needed text[];

-- Homeowners fields
alter table public.cs_intake_submissions add column if not exists property_address_street varchar(200);
alter table public.cs_intake_submissions add column if not exists property_address_city varchar(100);
alter table public.cs_intake_submissions add column if not exists property_address_state varchar(2);
alter table public.cs_intake_submissions add column if not exists property_address_zip varchar(10);
alter table public.cs_intake_submissions add column if not exists dwelling_type varchar(50);
alter table public.cs_intake_submissions add column if not exists year_built integer;
alter table public.cs_intake_submissions add column if not exists square_footage integer;
alter table public.cs_intake_submissions add column if not exists roof_type varchar(50);
alter table public.cs_intake_submissions add column if not exists roof_age integer;
alter table public.cs_intake_submissions add column if not exists coverage_amount numeric(12,2);
alter table public.cs_intake_submissions add column if not exists prior_claims boolean default false;
alter table public.cs_intake_submissions add column if not exists prior_claims_detail text;

-- Non-owners fields
alter table public.cs_intake_submissions add column if not exists sr22_filing_state varchar(2);
alter table public.cs_intake_submissions add column if not exists court_order_date date;

-- Link to commercial card (for commercial-routed intakes)
alter table public.cs_intake_submissions add column if not exists source_commercial_quote_id uuid references public.commercial_quotes(id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. EXPAND coverage_type ON commercial_quotes to include homeowners
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop and re-add check to include 'homeowners' and 'trucking'
alter table public.commercial_quotes drop constraint if exists commercial_quotes_coverage_type_check;

alter table public.commercial_quotes
  add constraint commercial_quotes_coverage_type_check
  check (coverage_type is null or coverage_type in (
    'gl', 'wc', 'umb', 'gl_wc', 'gl_wc_umb', 'bop',
    'commercial_auto', 'homeowners', 'trucking', 'other'
  ));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. NEW RPC: cs_intake_submit_commercial
--    Validates, creates a commercial_quotes card, links back to submission.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.cs_intake_submit_commercial(p_submission_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cs_intake_submissions%rowtype;
  v_card_id uuid;
  v_business_name text;
  v_coverage_type text;
  v_description text;
  v_assigned_to uuid;
  v_next_position integer;
  v_caller_role text;
  v_checklist_id uuid;
begin
  select * into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then raise exception 'Intake not found.'; end if;

  -- Allow creator or manager/super_admin to submit
  v_caller_role := public.nhwd_role();
  if v_row.created_by <> auth.uid() and v_caller_role not in ('manager', 'super_admin') then
    raise exception 'You cannot submit this intake.';
  end if;

  if v_row.status::text not in ('draft', 'returned') then
    raise exception 'Only Draft or Returned intakes can be submitted.';
  end if;

  -- Must be a commercial-routed LOB
  if v_row.line_of_business::text not in ('homeowners', 'trucking', 'commercial_gl') then
    raise exception 'This function only handles homeowners, trucking, and commercial GL intakes.';
  end if;

  -- Basic validation (name + phone required for all)
  if nullif(trim(v_row.insured_first_name), '') is null
     or nullif(trim(v_row.insured_last_name), '') is null
     or nullif(trim(v_row.insured_phone_primary), '') is null then
    raise exception 'Insured name and phone are required.';
  end if;

  -- LOB-specific validation
  if v_row.line_of_business::text = 'trucking' then
    if nullif(trim(v_row.business_name), '') is null then raise exception 'Business name is required for Trucking.'; end if;
    if nullif(trim(v_row.dot_number), '') is null then raise exception 'DOT number is required for Trucking.'; end if;
  end if;

  if v_row.line_of_business::text = 'commercial_gl' then
    if nullif(trim(v_row.business_name), '') is null then raise exception 'Business name is required for Commercial GL.'; end if;
  end if;

  if v_row.line_of_business::text = 'homeowners' then
    if nullif(trim(v_row.property_address_street), '') is null then
      raise exception 'Property address is required for Homeowners.';
    end if;
  end if;

  -- Determine business_name for the card
  v_business_name := coalesce(
    nullif(trim(v_row.business_name), ''),
    trim(v_row.insured_first_name || ' ' || v_row.insured_last_name)
  );

  -- Map LOB to coverage_type
  v_coverage_type := case v_row.line_of_business::text
    when 'trucking' then 'trucking'
    when 'commercial_gl' then 'gl'
    when 'homeowners' then 'homeowners'
  end;

  -- Build description from all intake data
  v_description := '';

  -- Customer section
  v_description := v_description || '── Customer ──────────────────────' || E'\n';
  v_description := v_description || 'Name: ' || trim(v_row.insured_first_name || ' ' || v_row.insured_last_name) || E'\n';
  if v_row.insured_dob is not null then
    v_description := v_description || 'DOB: ' || to_char(v_row.insured_dob, 'MM/DD/YYYY') || E'\n';
  end if;
  if v_row.insured_phone_primary is not null then
    v_description := v_description || 'Phone: ' || v_row.insured_phone_primary || E'\n';
  end if;
  if v_row.insured_phone_alt is not null then
    v_description := v_description || 'Alt Phone: ' || v_row.insured_phone_alt || E'\n';
  end if;
  if v_row.insured_email is not null then
    v_description := v_description || 'Email: ' || v_row.insured_email || E'\n';
  end if;
  if v_row.addr_street is not null then
    v_description := v_description || 'Address: ' || coalesce(v_row.addr_street, '') || ', ' || coalesce(v_row.addr_city, '') || ', ' || coalesce(v_row.addr_state, '') || ' ' || coalesce(v_row.addr_zip, '') || E'\n';
  end if;

  -- Business section (if applicable)
  if v_row.business_name is not null or v_row.ein is not null or v_row.dot_number is not null then
    v_description := v_description || E'\n' || '── Business ──────────────────────' || E'\n';
    if v_row.business_name is not null then
      v_description := v_description || 'Name: ' || v_row.business_name || E'\n';
    end if;
    if v_row.ein is not null then
      v_description := v_description || 'EIN: ' || v_row.ein || E'\n';
    end if;
    if v_row.business_type is not null then
      v_description := v_description || 'Type of work: ' || v_row.business_type || E'\n';
    end if;
    if v_row.years_in_business is not null then
      v_description := v_description || 'Years in business: ' || v_row.years_in_business || E'\n';
    end if;
    if v_row.dot_number is not null then
      v_description := v_description || 'DOT#: ' || v_row.dot_number || E'\n';
    end if;
    if v_row.mc_number is not null then
      v_description := v_description || 'MC#: ' || v_row.mc_number || E'\n';
    end if;
    if v_row.mcs150_date is not null then
      v_description := v_description || 'MCS-150: ' || to_char(v_row.mcs150_date, 'MM/DD/YYYY') || E'\n';
    end if;
    if v_row.cargo_type is not null then
      v_description := v_description || 'Cargo type: ' || v_row.cargo_type || E'\n';
    end if;
    if v_row.power_unit_count is not null then
      v_description := v_description || 'Power units: ' || v_row.power_unit_count || E'\n';
    end if;
    if v_row.operating_radius_miles is not null then
      v_description := v_description || 'Operating radius: ' || v_row.operating_radius_miles || ' mi' || E'\n';
    end if;
    if v_row.states_of_operation is not null then
      v_description := v_description || 'States: ' || v_row.states_of_operation || E'\n';
    end if;
    if v_row.employee_count is not null then
      v_description := v_description || 'Employees: ' || v_row.employee_count || E'\n';
    end if;
    if v_row.annual_payroll is not null then
      v_description := v_description || 'Annual payroll: $' || to_char(v_row.annual_payroll, 'FM999,999,999') || E'\n';
    end if;
  end if;

  -- Homeowners property section
  if v_row.line_of_business::text = 'homeowners' then
    v_description := v_description || E'\n' || '── Property ──────────────────────' || E'\n';
    if v_row.property_address_street is not null then
      v_description := v_description || 'Address: ' || coalesce(v_row.property_address_street, '') || ', ' || coalesce(v_row.property_address_city, '') || ', ' || coalesce(v_row.property_address_state, '') || ' ' || coalesce(v_row.property_address_zip, '') || E'\n';
    end if;
    if v_row.dwelling_type is not null then
      v_description := v_description || 'Dwelling: ' || v_row.dwelling_type || E'\n';
    end if;
    if v_row.year_built is not null then
      v_description := v_description || 'Year built: ' || v_row.year_built || E'\n';
    end if;
    if v_row.square_footage is not null then
      v_description := v_description || 'Sq ft: ' || v_row.square_footage || E'\n';
    end if;
    if v_row.roof_type is not null then
      v_description := v_description || 'Roof: ' || v_row.roof_type || E'\n';
    end if;
    if v_row.roof_age is not null then
      v_description := v_description || 'Roof age: ' || v_row.roof_age || ' yrs' || E'\n';
    end if;
    if v_row.coverage_amount is not null then
      v_description := v_description || 'Coverage amount: $' || to_char(v_row.coverage_amount, 'FM999,999,999') || E'\n';
    end if;
    if v_row.prior_claims then
      v_description := v_description || 'Prior claims: Yes' || E'\n';
      if v_row.prior_claims_detail is not null then
        v_description := v_description || 'Details: ' || v_row.prior_claims_detail || E'\n';
      end if;
    end if;
  end if;

  -- Coverage types needed (commercial GL)
  if v_row.coverage_types_needed is not null and array_length(v_row.coverage_types_needed, 1) > 0 then
    v_description := v_description || E'\n' || '── Coverage Needed ───────────────' || E'\n';
    v_description := v_description || array_to_string(v_row.coverage_types_needed, ', ') || E'\n';
  end if;

  -- Drivers (trucking / commercial_auto might have them)
  if exists (select 1 from public.cs_intake_drivers d where d.submission_id = v_row.id) then
    v_description := v_description || E'\n' || '── Drivers ───────────────────────' || E'\n';
    v_description := v_description || (
      select string_agg(
        (d.position || '. ' || d.first_name || ' ' || d.last_name
         || coalesce(' — DL# ' || d.license_number, '')
         || coalesce(' (' || d.license_state || ')', '')
         || case when d.dob is not null then ' — DOB ' || to_char(d.dob, 'MM/DD/YYYY') else '' end
        ), E'\n' order by d.position
      )
      from public.cs_intake_drivers d where d.submission_id = v_row.id
    ) || E'\n';
  end if;

  -- Vehicles
  if exists (select 1 from public.cs_intake_vehicles v where v.submission_id = v_row.id) then
    v_description := v_description || E'\n' || '── Vehicles ──────────────────────' || E'\n';
    v_description := v_description || (
      select string_agg(
        (v.position || '. ' || coalesce(v.year::text, '?') || ' ' || coalesce(v.make, '?') || ' ' || coalesce(v.model, '?')
         || case when v.vin is not null then ' — VIN: ' || v.vin else '' end
        ), E'\n' order by v.position
      )
      from public.cs_intake_vehicles v where v.submission_id = v_row.id
    ) || E'\n';
  end if;

  -- Current policy
  if v_row.current_carrier is not null or v_row.current_policy_number is not null then
    v_description := v_description || E'\n' || '── Current Policy ────────────────' || E'\n';
    if v_row.current_carrier is not null then
      v_description := v_description || 'Carrier: ' || v_row.current_carrier || E'\n';
    end if;
    if v_row.current_policy_number is not null then
      v_description := v_description || 'Policy#: ' || v_row.current_policy_number || E'\n';
    end if;
    if v_row.current_premium is not null then
      v_description := v_description || 'Premium: $' || to_char(v_row.current_premium, 'FM999,999') || '/yr' || E'\n';
    end if;
    if v_row.current_expiration is not null then
      v_description := v_description || 'Expires: ' || to_char(v_row.current_expiration, 'MM/DD/YYYY') || E'\n';
    end if;
  end if;

  -- Notes
  if nullif(trim(v_row.csr_notes), '') is not null then
    v_description := v_description || E'\n' || '── Notes ─────────────────────────' || E'\n';
    v_description := v_description || v_row.csr_notes || E'\n';
  end if;

  -- Determine assigned_to:
  -- If caller is an agent/commercial role, assign to them.
  -- If caller is CS or manager, assign to a manager (they will redistribute).
  if v_caller_role in ('agent', 'commercial') then
    v_assigned_to := auth.uid();
  else
    -- Assign to a manager. Pick the first manager profile as default.
    select id into v_assigned_to
    from public.profiles
    where role in ('manager', 'super_admin') and is_active = true
    order by role desc, display_name
    limit 1;

    -- Fallback: assign to the caller themselves
    if v_assigned_to is null then
      v_assigned_to := auth.uid();
    end if;
  end if;

  -- Get next position in quote_intake column
  select coalesce(max(column_position), 0) + 1 into v_next_position
  from public.commercial_quotes
  where board_column = 'quote_intake';

  -- Create the commercial card
  insert into public.commercial_quotes (
    business_name, description, board_column, column_position,
    risk_level, card_status, coverage_type, assigned_to, is_mirrored
  ) values (
    v_business_name, v_description, 'quote_intake', v_next_position,
    'medium', 'in_progress', v_coverage_type, v_assigned_to, true
  ) returning id into v_card_id;

  -- Record column history
  insert into public.commercial_quote_column_history (quote_id, from_column, to_column, moved_by)
  values (v_card_id, null, 'quote_intake', auth.uid());

  -- Log activity
  insert into public.commercial_quote_activity_log (quote_id, actor_id, event_type, details)
  values (v_card_id, auth.uid(), 'created', jsonb_build_object(
    'source', 'cs_intake',
    'intake_id', v_row.id,
    'line_of_business', v_row.line_of_business::text,
    'business_name', v_business_name
  ));

  -- Create default checklist
  insert into public.commercial_quote_checklists (quote_id, title, position)
  values (v_card_id, 'Required Documents', 0)
  returning id into v_checklist_id;

  insert into public.commercial_quote_checklist_items (checklist_id, label, position) values
    (v_checklist_id, 'Email', 1),
    (v_checklist_id, 'Recording', 2),
    (v_checklist_id, 'Form', 3);

  -- Update the intake submission
  update public.cs_intake_submissions
  set status = 'converted',
      source_commercial_quote_id = v_card_id,
      submitted_at = coalesce(submitted_at, now()),
      converted_at = now(),
      updated_at = now()
  where id = p_submission_id;

  -- Log intake event
  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (p_submission_id, auth.uid(), 'converted_commercial', jsonb_build_object(
    'commercial_quote_id', v_card_id,
    'business_name', v_business_name,
    'assigned_to', v_assigned_to,
    'coverage_type', v_coverage_type
  ));

  return v_card_id;
end;
$$;

grant execute on function public.cs_intake_submit_commercial(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. UPDATE cs_intake_submit to handle non_owners (no vehicles/drivers required)
--    and skip vehicle/driver checks for homeowners, trucking, commercial_gl
--    (those go through cs_intake_submit_commercial instead)
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
  if v_row.created_by <> auth.uid() and public.nhwd_role() not in ('manager', 'super_admin') then
    raise exception 'You cannot submit this intake.';
  end if;
  if v_row.status::text not in ('draft', 'returned') then
    raise exception 'Only Draft or Returned intakes can be submitted.';
  end if;

  -- This function handles personal-queue LOBs only
  if v_row.line_of_business::text not in ('auto', 'personal_auto', 'commercial_auto', 'non_owners') then
    raise exception 'Use cs_intake_submit_commercial for homeowners, trucking, and commercial GL intakes.';
  end if;

  -- Common validation
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

  -- Non-owners: skip coverage, drivers, and vehicles validation
  if v_row.line_of_business::text = 'non_owners' then
    -- Only need the SR-22 filing state
    if nullif(trim(v_row.sr22_filing_state), '') is null then
      raise exception 'SR-22 filing state is required for Non-Owners.';
    end if;
  else
    -- Auto types need coverage selection, drivers, vehicles
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
end;
$$;

grant execute on function public.cs_intake_submit(uuid) to authenticated;

commit;
