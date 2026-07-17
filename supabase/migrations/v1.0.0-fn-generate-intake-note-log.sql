-- New Hope Work Desk v1.0.0
-- Internal function: _generate_intake_note_log
-- Generates a formatted, human-readable Intake Note Log from a customer intake
-- record, including all associated drivers and vehicles.
--
-- Personal Auto Format sections (in order):
--   Customer, Source, Coverage Requested, Drivers, Vehicles, Additional Notes
--
-- Commercial Auto Format sections (in order):
--   Business, Source, Drivers, Vehicles, Coverage Requested, Additional Notes
--
-- Empty sections are omitted entirely. Original values are preserved verbatim.
-- Metadata header includes CS_User name, agent/claim reference, and generation timestamp.
--
-- Requirements: 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 11.4
-- Spec: customer-intake-claim-duplicate-quote

begin;

-- -----------------------------------------------------------------------------
-- _generate_intake_note_log(p_intake_id, p_agent_name)
-- SECURITY DEFINER internal function (no direct client access)
-- -----------------------------------------------------------------------------
create or replace function public._generate_intake_note_log(
  p_intake_id uuid,
  p_agent_name text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_intake   customer_intakes%rowtype;
  v_creator_name text;
  v_log      text := '';
  v_section  text;
  v_driver   record;
  v_vehicle  record;
  v_driver_count int;
  v_vehicle_count int;
  v_has_coverage boolean;
begin
  -- Fetch the intake record
  select * into v_intake from customer_intakes where id = p_intake_id;
  if not found then
    raise exception 'INTAKE_NOT_FOUND: Intake % does not exist.', p_intake_id;
  end if;

  -- Fetch the CS creator's display name
  select display_name into v_creator_name from profiles where id = v_intake.created_by;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- METADATA HEADER
  -- ═══════════════════════════════════════════════════════════════════════════
  v_log := '═══ INTAKE NOTE LOG ═══' || E'\n';
  v_log := v_log || 'Created by: ' || coalesce(v_creator_name, 'Unknown') || E'\n';
  if p_agent_name is not null then
    v_log := v_log || 'Agent: ' || p_agent_name || E'\n';
  end if;
  v_log := v_log || 'Generated: ' || to_char(now() at time zone 'America/Chicago', 'MM/DD/YYYY HH12:MI AM TZ') || E'\n';
  v_log := v_log || '───────────────────────' || E'\n\n';

  -- ═══════════════════════════════════════════════════════════════════════════
  -- FORMAT BRANCHING
  -- ═══════════════════════════════════════════════════════════════════════════
  if v_intake.line_of_business = 'personal_auto' then
    -- =========================================================================
    -- PERSONAL AUTO FORMAT
    -- Sections: Customer, Source, Coverage Requested, Drivers, Vehicles, Additional Notes
    -- =========================================================================

    -- ─── CUSTOMER ────────────────────────────────────────────────────────────
    v_section := '';
    if v_intake.insured_first_name is not null or v_intake.insured_last_name is not null then
      v_section := v_section || '  Name: ' || coalesce(v_intake.insured_first_name, '') || ' ' || coalesce(v_intake.insured_last_name, '') || E'\n';
    end if;
    if v_intake.insured_dob is not null then
      v_section := v_section || '  DOB: ' || to_char(v_intake.insured_dob, 'MM/DD/YYYY') || E'\n';
    end if;
    if v_intake.insured_phone_primary is not null then
      v_section := v_section || '  Phone: ' || v_intake.insured_phone_primary || E'\n';
    end if;
    if v_intake.insured_phone_alt is not null then
      v_section := v_section || '  Alt Phone: ' || v_intake.insured_phone_alt || E'\n';
    end if;
    if v_intake.insured_email is not null then
      v_section := v_section || '  Email: ' || v_intake.insured_email || E'\n';
    end if;
    if v_intake.preferred_language is not null then
      v_section := v_section || '  Language: ' || v_intake.preferred_language || E'\n';
    end if;
    if v_intake.preferred_contact is not null then
      v_section := v_section || '  Preferred Contact: ' || v_intake.preferred_contact || E'\n';
    end if;
    if v_intake.addr_street is not null then
      v_section := v_section || '  Address: ' || v_intake.addr_street;
      if v_intake.addr_unit is not null then
        v_section := v_section || ' ' || v_intake.addr_unit;
      end if;
      v_section := v_section || ', ' || coalesce(v_intake.addr_city, '') || ' ' || coalesce(v_intake.addr_state, '') || ' ' || coalesce(v_intake.addr_zip, '') || E'\n';
    end if;

    if v_section != '' then
      v_log := v_log || '▸ CUSTOMER' || E'\n' || v_section || E'\n';
    end if;

    -- ─── SOURCE ──────────────────────────────────────────────────────────────
    v_section := '';
    v_section := v_section || '  Type: ' || replace(v_intake.source_type, '_', ' ') || E'\n';
    if v_intake.source_description is not null then
      v_section := v_section || '  Description: ' || v_intake.source_description || E'\n';
    end if;
    if v_intake.dealer_id is not null then
      v_section := v_section || '  Dealership: ' || coalesce((select name from dealers where id = v_intake.dealer_id), v_intake.dealer_id::text) || E'\n';
    end if;
    if v_intake.dealer_salesperson_id is not null then
      v_section := v_section || '  Salesperson: ' || coalesce((select name from dealer_salespeople where id = v_intake.dealer_salesperson_id), v_intake.dealer_salesperson_id::text) || E'\n';
    end if;
    if v_intake.quote_origin is not null then
      v_section := v_section || '  Origin: ' || v_intake.quote_origin || E'\n';
    end if;

    -- Source always has at least the Type line, so always include
    v_log := v_log || '▸ SOURCE' || E'\n' || v_section || E'\n';

    -- ─── COVERAGE REQUESTED ──────────────────────────────────────────────────
    v_section := '';
    if v_intake.desired_coverage is not null then
      v_section := v_section || '  Desired: ' || replace(v_intake.desired_coverage, '_', ' ') || E'\n';
    end if;
    if v_intake.liability_limit is not null then
      v_section := v_section || '  Liability Limit: ' || v_intake.liability_limit || E'\n';
    end if;
    if v_intake.comprehensive_deductible is not null then
      v_section := v_section || '  Comp Deductible: ' || v_intake.comprehensive_deductible || E'\n';
    end if;
    if v_intake.collision_deductible is not null then
      v_section := v_section || '  Coll Deductible: ' || v_intake.collision_deductible || E'\n';
    end if;
    if v_intake.current_carrier is not null then
      v_section := v_section || '  Current Carrier: ' || v_intake.current_carrier || E'\n';
    end if;
    if v_intake.current_policy_number is not null then
      v_section := v_section || '  Policy Number: ' || v_intake.current_policy_number || E'\n';
    end if;
    if v_intake.current_premium is not null then
      v_section := v_section || '  Current Premium: $' || v_intake.current_premium::text || E'\n';
    end if;
    if v_intake.current_expiration is not null then
      v_section := v_section || '  Expiration: ' || to_char(v_intake.current_expiration, 'MM/DD/YYYY') || E'\n';
    end if;
    if v_intake.prior_insurance is not null then
      v_section := v_section || '  Prior Insurance: ' || case when v_intake.prior_insurance then 'Yes' else 'No' end || E'\n';
    end if;
    if v_intake.prior_lapse is not null then
      v_section := v_section || '  Prior Lapse: ' || case when v_intake.prior_lapse then 'Yes' else 'No' end || E'\n';
    end if;
    if v_intake.months_continuous_coverage is not null then
      v_section := v_section || '  Months Continuous: ' || v_intake.months_continuous_coverage::text || E'\n';
    end if;

    if v_section != '' then
      v_log := v_log || '▸ COVERAGE REQUESTED' || E'\n' || v_section || E'\n';
    end if;

    -- ─── DRIVERS ─────────────────────────────────────────────────────────────
    select count(*) into v_driver_count from cs_intake_drivers where submission_id = p_intake_id;
    if v_driver_count > 0 then
      v_section := '';
      for v_driver in
        select * from cs_intake_drivers where submission_id = p_intake_id order by position asc
      loop
        v_section := v_section || '  [' || v_driver.position || '] ' || v_driver.first_name || ' ' || v_driver.last_name;
        if v_driver.dob is not null then
          v_section := v_section || ' (DOB: ' || to_char(v_driver.dob::date, 'MM/DD/YYYY') || ')';
        end if;
        if v_driver.relationship is not null then
          v_section := v_section || ' — ' || v_driver.relationship;
        end if;
        v_section := v_section || E'\n';
        if v_driver.license_number is not null then
          v_section := v_section || '     DL: ' || v_driver.license_number || ' (' || coalesce(v_driver.license_state, '') || ')' || E'\n';
        end if;
        if v_driver.license_status is not null then
          v_section := v_section || '     Status: ' || v_driver.license_status || E'\n';
        end if;
        if v_driver.years_licensed is not null then
          v_section := v_section || '     Years Licensed: ' || v_driver.years_licensed::text || E'\n';
        end if;
        if v_driver.sr22_required then
          v_section := v_section || '     SR-22: Required' || E'\n';
        end if;
      end loop;
      v_log := v_log || '▸ DRIVERS' || E'\n' || v_section || E'\n';
    end if;

    -- ─── VEHICLES ────────────────────────────────────────────────────────────
    select count(*) into v_vehicle_count from cs_intake_vehicles where submission_id = p_intake_id;
    if v_vehicle_count > 0 then
      v_section := '';
      for v_vehicle in
        select * from cs_intake_vehicles where submission_id = p_intake_id order by position asc
      loop
        v_section := v_section || '  [' || v_vehicle.position || '] ';
        v_section := v_section || coalesce(v_vehicle.year::text, '') || ' ' || coalesce(v_vehicle.make, '') || ' ' || coalesce(v_vehicle.model, '') || E'\n';
        if v_vehicle.vin is not null then
          v_section := v_section || '     VIN: ' || v_vehicle.vin || E'\n';
        end if;
        if v_vehicle.ownership is not null then
          v_section := v_section || '     Ownership: ' || v_vehicle.ownership || E'\n';
        end if;
        if v_vehicle.lienholder is not null then
          v_section := v_section || '     Lienholder: ' || v_vehicle.lienholder || E'\n';
        end if;
        if v_vehicle.usage is not null then
          v_section := v_section || '     Usage: ' || v_vehicle.usage || E'\n';
        end if;
        if v_vehicle.annual_mileage is not null then
          v_section := v_section || '     Mileage: ' || v_vehicle.annual_mileage::text || '/yr' || E'\n';
        end if;
        if v_vehicle.garaging_zip is not null then
          v_section := v_section || '     Garaging ZIP: ' || v_vehicle.garaging_zip || E'\n';
        end if;
      end loop;
      v_log := v_log || '▸ VEHICLES' || E'\n' || v_section || E'\n';
    end if;

  else
    -- =========================================================================
    -- COMMERCIAL AUTO FORMAT
    -- Sections: Business, Source, Drivers, Vehicles, Coverage Requested, Additional Notes
    -- =========================================================================

    -- ─── BUSINESS ────────────────────────────────────────────────────────────
    v_section := '';
    if v_intake.business_name is not null then
      v_section := v_section || '  Name: ' || v_intake.business_name || E'\n';
    end if;
    if v_intake.business_type is not null then
      v_section := v_section || '  Type of Work: ' || v_intake.business_type || E'\n';
    end if;
    if v_intake.dot_number is not null then
      v_section := v_section || '  DOT: ' || v_intake.dot_number || E'\n';
    elsif v_intake.dot_not_applicable then
      v_section := v_section || '  DOT: N/A' || E'\n';
    end if;
    if v_intake.years_in_business is not null then
      v_section := v_section || '  Years in Business: ' || v_intake.years_in_business::text || E'\n';
    end if;
    if v_intake.operating_radius_miles is not null then
      v_section := v_section || '  Operating Radius: ' || v_intake.operating_radius_miles::text || ' miles' || E'\n';
    end if;

    if v_section != '' then
      v_log := v_log || '▸ BUSINESS' || E'\n' || v_section || E'\n';
    end if;

    -- ─── SOURCE ──────────────────────────────────────────────────────────────
    v_section := '';
    v_section := v_section || '  Type: ' || replace(v_intake.source_type, '_', ' ') || E'\n';
    if v_intake.source_description is not null then
      v_section := v_section || '  Description: ' || v_intake.source_description || E'\n';
    end if;
    if v_intake.dealer_id is not null then
      v_section := v_section || '  Dealership: ' || coalesce((select name from dealers where id = v_intake.dealer_id), v_intake.dealer_id::text) || E'\n';
    end if;
    if v_intake.dealer_salesperson_id is not null then
      v_section := v_section || '  Salesperson: ' || coalesce((select name from dealer_salespeople where id = v_intake.dealer_salesperson_id), v_intake.dealer_salesperson_id::text) || E'\n';
    end if;
    if v_intake.quote_origin is not null then
      v_section := v_section || '  Origin: ' || v_intake.quote_origin || E'\n';
    end if;

    v_log := v_log || '▸ SOURCE' || E'\n' || v_section || E'\n';

    -- ─── DRIVERS ─────────────────────────────────────────────────────────────
    select count(*) into v_driver_count from cs_intake_drivers where submission_id = p_intake_id;
    if v_driver_count > 0 then
      v_section := '';
      for v_driver in
        select * from cs_intake_drivers where submission_id = p_intake_id order by position asc
      loop
        v_section := v_section || '  [' || v_driver.position || '] ' || v_driver.first_name || ' ' || v_driver.last_name;
        if v_driver.dob is not null then
          v_section := v_section || ' (DOB: ' || to_char(v_driver.dob::date, 'MM/DD/YYYY') || ')';
        end if;
        if v_driver.relationship is not null then
          v_section := v_section || ' — ' || v_driver.relationship;
        end if;
        v_section := v_section || E'\n';
        if v_driver.license_number is not null then
          v_section := v_section || '     DL: ' || v_driver.license_number || ' (' || coalesce(v_driver.license_state, '') || ')' || E'\n';
        end if;
        if v_driver.license_status is not null then
          v_section := v_section || '     Status: ' || v_driver.license_status || E'\n';
        end if;
        if v_driver.years_licensed is not null then
          v_section := v_section || '     Years Licensed: ' || v_driver.years_licensed::text || E'\n';
        end if;
        if v_driver.sr22_required then
          v_section := v_section || '     SR-22: Required' || E'\n';
        end if;
      end loop;
      v_log := v_log || '▸ DRIVERS' || E'\n' || v_section || E'\n';
    end if;

    -- ─── VEHICLES ────────────────────────────────────────────────────────────
    select count(*) into v_vehicle_count from cs_intake_vehicles where submission_id = p_intake_id;
    if v_vehicle_count > 0 then
      v_section := '';
      for v_vehicle in
        select * from cs_intake_vehicles where submission_id = p_intake_id order by position asc
      loop
        v_section := v_section || '  [' || v_vehicle.position || '] ';
        v_section := v_section || coalesce(v_vehicle.year::text, '') || ' ' || coalesce(v_vehicle.make, '') || ' ' || coalesce(v_vehicle.model, '') || E'\n';
        if v_vehicle.vin is not null then
          v_section := v_section || '     VIN: ' || v_vehicle.vin || E'\n';
        end if;
        if v_vehicle.ownership is not null then
          v_section := v_section || '     Ownership: ' || v_vehicle.ownership || E'\n';
        end if;
        if v_vehicle.lienholder is not null then
          v_section := v_section || '     Lienholder: ' || v_vehicle.lienholder || E'\n';
        end if;
        if v_vehicle.usage is not null then
          v_section := v_section || '     Usage: ' || v_vehicle.usage || E'\n';
        end if;
        if v_vehicle.annual_mileage is not null then
          v_section := v_section || '     Mileage: ' || v_vehicle.annual_mileage::text || '/yr' || E'\n';
        end if;
        if v_vehicle.garaging_zip is not null then
          v_section := v_section || '     Garaging ZIP: ' || v_vehicle.garaging_zip || E'\n';
        end if;
      end loop;
      v_log := v_log || '▸ VEHICLES' || E'\n' || v_section || E'\n';
    end if;

    -- ─── COVERAGE REQUESTED ──────────────────────────────────────────────────
    v_section := '';
    if v_intake.desired_coverage is not null then
      v_section := v_section || '  Desired: ' || replace(v_intake.desired_coverage, '_', ' ') || E'\n';
    end if;
    if v_intake.liability_limit is not null then
      v_section := v_section || '  Liability Limit: ' || v_intake.liability_limit || E'\n';
    end if;
    if v_intake.comprehensive_deductible is not null then
      v_section := v_section || '  Comp Deductible: ' || v_intake.comprehensive_deductible || E'\n';
    end if;
    if v_intake.collision_deductible is not null then
      v_section := v_section || '  Coll Deductible: ' || v_intake.collision_deductible || E'\n';
    end if;
    if v_intake.current_carrier is not null then
      v_section := v_section || '  Current Carrier: ' || v_intake.current_carrier || E'\n';
    end if;
    if v_intake.current_policy_number is not null then
      v_section := v_section || '  Policy Number: ' || v_intake.current_policy_number || E'\n';
    end if;
    if v_intake.current_premium is not null then
      v_section := v_section || '  Current Premium: $' || v_intake.current_premium::text || E'\n';
    end if;
    if v_intake.current_expiration is not null then
      v_section := v_section || '  Expiration: ' || to_char(v_intake.current_expiration, 'MM/DD/YYYY') || E'\n';
    end if;
    if v_intake.prior_insurance is not null then
      v_section := v_section || '  Prior Insurance: ' || case when v_intake.prior_insurance then 'Yes' else 'No' end || E'\n';
    end if;
    if v_intake.prior_lapse is not null then
      v_section := v_section || '  Prior Lapse: ' || case when v_intake.prior_lapse then 'Yes' else 'No' end || E'\n';
    end if;
    if v_intake.months_continuous_coverage is not null then
      v_section := v_section || '  Months Continuous: ' || v_intake.months_continuous_coverage::text || E'\n';
    end if;

    if v_section != '' then
      v_log := v_log || '▸ COVERAGE REQUESTED' || E'\n' || v_section || E'\n';
    end if;

  end if;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- ADDITIONAL NOTES (both formats, always last)
  -- ═══════════════════════════════════════════════════════════════════════════
  if v_intake.csr_notes is not null and trim(v_intake.csr_notes) != '' then
    v_log := v_log || '▸ ADDITIONAL NOTES' || E'\n';
    v_log := v_log || '  ' || v_intake.csr_notes || E'\n';
  end if;

  return v_log;
end;
$$;

-- -----------------------------------------------------------------------------
-- Verification: confirm function was created successfully
-- -----------------------------------------------------------------------------
do $verify$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on p.pronamespace = n.oid
    where n.nspname = 'public'
      and p.proname = '_generate_intake_note_log'
  ) then
    raise exception '_generate_intake_note_log function was not created.';
  end if;
end
$verify$;

commit;

select 'v1.0.0 _generate_intake_note_log function installed' as status;
