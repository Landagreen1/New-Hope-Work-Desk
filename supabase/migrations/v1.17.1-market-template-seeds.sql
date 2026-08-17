-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.17.1 — JSA & TIA Template Configuration Seeds
--
-- Seeds PDF template metadata for JSA Truck Application and TIA Quick Quote.
-- The actual blank PDF templates must be uploaded manually by a manager.
-- Field mappings define how Work Desk data maps to each template's fields.
--
-- Safe to re-run: uses ON CONFLICT.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. JSA TRUCK APPLICATION TEMPLATE
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.market_pdf_templates (
  market_id, line_of_business, template_name, version_label,
  is_active, field_mapping, total_pages, max_drivers, max_vehicles, max_trailers
)
select
  md.id,
  'trucking',
  'JSA Truck Application',
  '1.0',
  true,
  '{
    "business.legal_name": {"pdf_field": "Applicant", "page": 1},
    "business.dba": {"pdf_field": "DBA", "page": 1},
    "business.mailing_street": {"pdf_field": "Mailing Address", "page": 1},
    "business.mailing_city": {"pdf_field": "City", "page": 1},
    "business.mailing_state": {"pdf_field": "State", "page": 1},
    "business.mailing_zip": {"pdf_field": "Zip", "page": 1},
    "business.phone": {"pdf_field": "Phone", "page": 1},
    "business.email": {"pdf_field": "Email", "page": 1},
    "business.dot_number": {"pdf_field": "DOT#", "page": 1},
    "business.mc_number": {"pdf_field": "MC#", "page": 1},
    "business.entity_type": {"pdf_field": "Entity Type", "page": 1},
    "business.years_in_business": {"pdf_field": "Years in Business", "page": 1},
    "business.years_experience": {"pdf_field": "Years Experience", "page": 1},
    "business.fein": {"pdf_field": "FEIN", "page": 1},
    "owners[0].name": {"pdf_field": "Owner Name", "page": 1},
    "owners[0].dob": {"pdf_field": "Owner DOB", "page": 1},
    "operations.commodities": {"pdf_field": "Commodities Hauled", "page": 2},
    "operations.radius": {"pdf_field": "Radius of Operations", "page": 2},
    "operations.states": {"pdf_field": "States of Operation", "page": 2},
    "operations.brokerage_percentage": {"pdf_field": "% Through Brokers", "page": 2},
    "operations.interstate": {"pdf_field": "Interstate Y/N", "page": 2},
    "coverages.auto_liability_limit": {"pdf_field": "AL Limit", "page": 2},
    "coverages.cargo_limit": {"pdf_field": "Cargo Limit", "page": 2},
    "coverages.comprehensive_deductible": {"pdf_field": "Comp Deductible", "page": 2},
    "coverages.collision_deductible": {"pdf_field": "Collision Deductible", "page": 2},
    "prior_insurance.carrier": {"pdf_field": "Current Carrier", "page": 2},
    "prior_insurance.premium": {"pdf_field": "Current Premium", "page": 2},
    "prior_insurance.expiration": {"pdf_field": "Expiration Date", "page": 2},
    "drivers[0].first_name": {"pdf_field": "Driver 1 First", "page": 3},
    "drivers[0].last_name": {"pdf_field": "Driver 1 Last", "page": 3},
    "drivers[0].dob": {"pdf_field": "Driver 1 DOB", "page": 3},
    "drivers[0].license_number": {"pdf_field": "Driver 1 License", "page": 3},
    "drivers[0].license_state": {"pdf_field": "Driver 1 State", "page": 3},
    "drivers[0].years_licensed": {"pdf_field": "Driver 1 Exp", "page": 3},
    "vehicles[0].year": {"pdf_field": "Unit 1 Year", "page": 4},
    "vehicles[0].make": {"pdf_field": "Unit 1 Make", "page": 4},
    "vehicles[0].vin": {"pdf_field": "Unit 1 VIN", "page": 4},
    "vehicles[0].value": {"pdf_field": "Unit 1 Value", "page": 4},
    "vehicles[0].gvw": {"pdf_field": "Unit 1 GVW", "page": 4}
  }'::jsonb,
  5,
  10,
  15,
  10
from public.market_directory md
where md.name = 'JSA'
on conflict (market_id, line_of_business, template_name, version_label) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. TIA QUICK QUOTE TEMPLATE
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.market_pdf_templates (
  market_id, line_of_business, template_name, version_label,
  is_active, field_mapping, total_pages, max_drivers, max_vehicles, max_trailers
)
select
  md.id,
  'trucking',
  'TIA Quick Quote',
  '1.0',
  true,
  '{
    "business.legal_name": {"pdf_field": "Named Insured", "page": 1},
    "business.mailing_street": {"pdf_field": "Address", "page": 1},
    "business.mailing_city": {"pdf_field": "City", "page": 1},
    "business.mailing_state": {"pdf_field": "State", "page": 1},
    "business.mailing_zip": {"pdf_field": "Zip", "page": 1},
    "business.phone": {"pdf_field": "Phone", "page": 1},
    "business.dot_number": {"pdf_field": "DOT", "page": 1},
    "business.mc_number": {"pdf_field": "MC", "page": 1},
    "owners[0].name": {"pdf_field": "Contact Name", "page": 1},
    "operations.commodities": {"pdf_field": "Commodities", "page": 1},
    "operations.radius": {"pdf_field": "Operating Radius", "page": 1},
    "operations.states": {"pdf_field": "Destinations", "page": 1},
    "operations.revenue": {"pdf_field": "Revenue", "page": 1},
    "operations.mileage": {"pdf_field": "Annual Mileage", "page": 1},
    "operations.brokerage_percentage": {"pdf_field": "Broker %", "page": 1},
    "coverages.auto_liability_limit": {"pdf_field": "Liability Limit", "page": 1},
    "coverages.cargo_limit": {"pdf_field": "Cargo", "page": 1},
    "coverages.physical_damage": {"pdf_field": "Physical Damage Y/N", "page": 1},
    "prior_insurance.carrier": {"pdf_field": "Prior Carrier", "page": 1},
    "prior_insurance.premium": {"pdf_field": "Prior Premium", "page": 1},
    "prior_insurance.expiration": {"pdf_field": "Exp Date", "page": 1},
    "prior_insurance.lapse": {"pdf_field": "Lapse Y/N", "page": 1},
    "drivers[0].first_name": {"pdf_field": "Driver 1 Name", "page": 2},
    "drivers[0].dob": {"pdf_field": "Driver 1 DOB", "page": 2},
    "drivers[0].license_number": {"pdf_field": "Driver 1 CDL", "page": 2},
    "drivers[0].license_state": {"pdf_field": "Driver 1 St", "page": 2},
    "vehicles[0].year": {"pdf_field": "Veh 1 Year", "page": 2},
    "vehicles[0].make": {"pdf_field": "Veh 1 Make/Model", "page": 2},
    "vehicles[0].vin": {"pdf_field": "Veh 1 VIN", "page": 2},
    "vehicles[0].value": {"pdf_field": "Veh 1 Value", "page": 2}
  }'::jsonb,
  2,
  5,
  10,
  5
from public.market_directory md
where md.name = 'Truckers Insurance Associates / TIA'
on conflict (market_id, line_of_business, template_name, version_label) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. SEED JSA-SPECIFIC QUESTIONS
--
--    These are JSA-specific fields NOT already in the CS intake.
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.market_questions (market_id, line_of_business, question_text, field_type, is_required, sort_order, auto_fill_source)
select md.id, 'trucking', q.question_text, q.field_type, q.is_required, q.sort_order, q.auto_fill_source
from public.market_directory md
cross join (values
  ('Projected Revenue', 'currency', true, 1, null),
  ('Target Premium', 'currency', false, 2, null),
  ('Percentage of Loads Through Brokers', 'percentage', true, 3, null),
  ('Any Owner Operators?', 'yes_no', true, 4, null),
  ('Number of Owner Operators', 'number', false, 5, null),
  ('New Venture (less than 3 years)?', 'yes_no', true, 6, null),
  ('Any DOT violations in past 3 years?', 'yes_no', true, 7, null),
  ('Any accidents in past 3 years?', 'yes_no', true, 8, null),
  ('Desired effective date', 'date', true, 9, null)
) as q(question_text, field_type, is_required, sort_order, auto_fill_source)
where md.name = 'JSA'
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. SEED TIA-SPECIFIC QUESTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.market_questions (market_id, line_of_business, question_text, field_type, is_required, sort_order, auto_fill_source)
select md.id, 'trucking', q.question_text, q.field_type, q.is_required, q.sort_order, q.auto_fill_source
from public.market_directory md
cross join (values
  ('Annual Revenue', 'currency', true, 1, null),
  ('Annual Mileage', 'number', true, 2, null),
  ('Primary Destinations', 'text', true, 3, null),
  ('Percentage of Loads Brokered', 'percentage', false, 4, null),
  ('Target effective date', 'date', true, 5, null),
  ('Any cargo claims in past 5 years?', 'yes_no', true, 6, null),
  ('Refrigerated loads?', 'yes_no', false, 7, null),
  ('Hazmat hauling?', 'yes_no', false, 8, null)
) as q(question_text, field_type, is_required, sort_order, auto_fill_source)
where md.name = 'Truckers Insurance Associates / TIA'
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. SEED JSA REQUIREMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.market_requirements (market_id, line_of_business, requirement_type, label, description, is_required, sort_order)
select md.id, 'trucking', r.requirement_type, r.label, r.description, r.is_required, r.sort_order
from public.market_directory md
cross join (values
  ('data', 'DOT Number', 'Federal DOT number for SAFER verification', true, 1),
  ('data', 'MC Number', 'Motor carrier number if applicable', false, 2),
  ('data', 'Projected Revenue', 'Annual projected revenue', true, 3),
  ('data', 'Target Premium', 'Customer target premium if stated', false, 4),
  ('document', 'Loss Runs (3+ years)', 'Loss runs from current/prior carriers', true, 5),
  ('document', 'Current Declarations Page', 'Current policy declarations', true, 6),
  ('document', 'Driver Licenses', 'CDL copies for all listed drivers', true, 7),
  ('document', 'Vehicle Registrations', 'Registration cards for all units', false, 8),
  ('application', 'JSA Truck Application', 'Completed JSA application form', true, 9)
) as r(requirement_type, label, description, is_required, sort_order)
where md.name = 'JSA'
on conflict (market_id, line_of_business, label) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. SEED TIA REQUIREMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.market_requirements (market_id, line_of_business, requirement_type, label, description, is_required, sort_order)
select md.id, 'trucking', r.requirement_type, r.label, r.description, r.is_required, r.sort_order
from public.market_directory md
cross join (values
  ('data', 'DOT Number', 'Federal DOT number', true, 1),
  ('data', 'Annual Revenue', 'Annual trucking revenue', true, 2),
  ('data', 'Annual Mileage', 'Total annual miles', true, 3),
  ('document', 'Loss Runs (3+ years)', 'Loss history from current/prior carriers', true, 4),
  ('document', 'MVR Reports', 'Motor vehicle records for all drivers', false, 5),
  ('application', 'TIA Quick Quote', 'Completed TIA Quick Quote form', true, 6)
) as r(requirement_type, label, description, is_required, sort_order)
where md.name = 'Truckers Insurance Associates / TIA'
on conflict (market_id, line_of_business, label) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_templates integer;
  v_questions integer;
  v_requirements integer;
begin
  select count(*) into v_templates from public.market_pdf_templates;
  select count(*) into v_questions from public.market_questions;
  select count(*) into v_requirements from public.market_requirements;
  raise notice 'v1.17.1 Seeds: % templates, % questions, % requirements', v_templates, v_questions, v_requirements;
end $$;

commit;
