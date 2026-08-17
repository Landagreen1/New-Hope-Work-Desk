-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.17.2 — Update Template Field Mappings from Official PDFs
--
-- Updates the JSA Truck Application and TIA Quick Quote template configurations
-- to match the actual official PDF form field layouts. Also adds missing
-- supplemental questions identified from the real forms.
--
-- Safe: UPDATE only, no drops.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. UPDATE TIA TEMPLATE — Match official Quick Quote Form layout
-- ═══════════════════════════════════════════════════════════════════════════════

update public.market_pdf_templates
set
  field_mapping = '{
    "page_1": {
      "section": "full_form",
      "fields": {
        "effective_dates": "business.effective_date",
        "insured_name": "business.legal_name",
        "dba": "business.dba",
        "garaging_address": "business.garaging_address",
        "mailing_address": "business.mailing_address",
        "agency": "New Hope Insurance",
        "producer": "agent.name",
        "phone": "business.phone",
        "email": "business.email",
        "destination_cities": "supplemental.Primary Destinations",
        "cities_traveled_through": "operations.states",
        "pct_loads_brokers": "supplemental.Percentage of Loads Brokered",
        "pct_loads_regular": "",
        "power_units_current": "vehicles.count",
        "power_units_prior": "",
        "gross_revenue_past": "supplemental.Annual Revenue",
        "gross_revenue_projected": "",
        "past_year_mileage": "supplemental.Annual Mileage",
        "projected_mileage": "",
        "dot_number": "business.dot_number",
        "mc_number": "business.mc_number",
        "fein": "business.fein",
        "eld_manufacturer": "",
        "years_insured": "business.years_in_business",
        "owner_ssn": "",
        "cancelled_nonrenewed": ""
      }
    },
    "driver_table": {
      "columns": ["name", "license", "state", "dob", "hire_date", "years_exp"],
      "max_rows": 5
    },
    "vehicle_table": {
      "columns": ["year", "make", "vin", "trk_trac", "trl_type", "value", "gvw", "radius"],
      "max_rows": 6
    },
    "insurance_carrier_table": {
      "columns": ["policy_dates", "company", "units_insured", "claims", "amount_incurred", "driver_name"],
      "max_rows": 3
    },
    "coverages": {
      "auto_liability_limit": "coverages.auto_liability_limit",
      "um_uim_limits": "",
      "cargo_limit": "coverages.cargo_limit",
      "cargo_deductible": "",
      "cargo_commodities": "operations.commodities",
      "physical_damage_coll_ded": "coverages.collision_deductible",
      "physical_damage_otc_ded": "coverages.comprehensive_deductible",
      "general_liability_limit": "",
      "hired_auto_liability": "",
      "medical_payments": "",
      "personal_injury_protection": ""
    },
    "submission_email": "newsubmissions@truckers-insurance.com",
    "submission_url": "www.truckers-insurance.com/quote"
  }'::jsonb,
  total_pages = 1,
  max_drivers = 5,
  max_vehicles = 6,
  max_trailers = 6,
  updated_at = now()
where template_name = 'TIA Quick Quote'
  and market_id = (select id from public.market_directory where name = 'Truckers Insurance Associates / TIA');

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. UPDATE JSA TEMPLATE — Match official 3-page Truck Application layout
-- ═══════════════════════════════════════════════════════════════════════════════

update public.market_pdf_templates
set
  field_mapping = '{
    "page_1_general_info": {
      "applicant_name": "business.legal_name",
      "mailing_address": "business.mailing_address",
      "location_address": "business.garaging_address",
      "owner_name": "owners[0].name",
      "owner_dob": "owners[0].dob",
      "owner_cdl": "Yes",
      "entity_type": "business.entity_type",
      "dot_number": "business.dot_number",
      "mc_number": "business.mc_number",
      "years_insured": "business.years_in_business",
      "years_experience": "business.years_experience",
      "renewal_date": "supplemental.Desired effective date",
      "description_operations": "operations.commodities",
      "narrative_target_premium": "supplemental.Target Premium",
      "agent_name": "Jason Toro",
      "agent_email": "jtoro@newhopeins.com",
      "agency_name": "New Hope Insurance"
    },
    "page_1_underwriting_questions": {
      "q1_cancelled_nonrenewed": "supplemental.cancelled_nonrenewed",
      "q2_lapse_coverage": "prior_insurance.lapse",
      "q3_fraud_convictions": "No",
      "q4_bankruptcies_liens": "No",
      "q5_losses_over_250k": "No",
      "q6_hazmat": "supplemental.Hazmat hauling?",
      "q7_cross_state_lines": "operations.interstate",
      "q8_haul_for_hire": "operations.for_hire",
      "q9_all_vehicles_listed": "Yes",
      "q10_owner_operators": "supplemental.Any Owner Operators?",
      "q11_rent_units": "No",
      "q12_team_drivers_slip_seating": "No"
    },
    "page_1_radius": "operations.states",
    "page_2_coverages": {
      "auto_liability_limits": "coverages.auto_liability_limit",
      "um_uim_limits": "",
      "hired_auto": "",
      "non_owned_auto": "",
      "physical_damage_deductible": "coverages.collision_deductible",
      "cause_of_loss": "Comprehensive, Collision",
      "cargo_limits": "coverages.cargo_limit",
      "cargo_deductible": "",
      "refrigeration_breakdown": "No",
      "trailer_interchange_limits": "",
      "trailer_interchange_deductible": "",
      "general_liability_limits": "",
      "general_liability_payroll": "",
      "medical_payments_limits": ""
    },
    "page_2_power_units": {
      "columns": ["year", "make", "body_type", "vin", "actual_cash_value", "owned_leased_oo", "additional_insured_lessor"],
      "max_rows": 15
    },
    "page_2_trailers": {
      "columns": ["year", "make", "body_type", "vin", "actual_cash_value", "additional_insured_lessor"],
      "max_rows": 10
    },
    "page_2_drivers": {
      "columns": ["driver_name", "dob", "state", "license_number", "years_cdl_experience", "owner_operator", "violations_accidents"],
      "max_rows": 10
    },
    "page_2_commodities": {
      "columns": ["commodities", "percent_hauled", "average_value", "maximum_value"]
    },
    "page_3_prior_carrier": {
      "columns": ["policy_period", "12mo_term", "insurance_company", "line_of_business", "policy_number", "num_power_units_value", "num_claims", "losses_paid_reserves"],
      "max_rows": 5
    }
  }'::jsonb,
  total_pages = 3,
  max_drivers = 10,
  max_vehicles = 15,
  max_trailers = 10,
  updated_at = now()
where template_name = 'JSA Truck Application'
  and market_id = (select id from public.market_directory where name = 'JSA');

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. ADD MISSING TIA QUESTIONS (from official form)
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.market_questions (market_id, line_of_business, question_text, field_type, is_required, sort_order, auto_fill_source)
select md.id, 'trucking', q.question_text, q.field_type, q.is_required, q.sort_order, q.auto_fill_source
from public.market_directory md
cross join (values
  ('ELD Manufacturer', 'text', false, 9, null),
  ('Owner Social Security Number (last 4)', 'text', false, 10, null),
  ('Cancelled or Non-Renewed in Past 3 Years?', 'yes_no', true, 11, null),
  ('If cancelled/non-renewed, reason', 'text', false, 12, null),
  ('Percentage of Loads to Regular Destinations', 'percentage', false, 13, null),
  ('# of Power Units Prior Year', 'number', false, 14, null),
  ('Projected Mileage', 'number', false, 15, null),
  ('Projected Revenue', 'currency', false, 16, null)
) as q(question_text, field_type, is_required, sort_order, auto_fill_source)
where md.name = 'Truckers Insurance Associates / TIA'
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. ADD MISSING JSA QUESTIONS (from official form)
-- ═══════════════════════════════════════════════════════════════════════════════

insert into public.market_questions (market_id, line_of_business, question_text, field_type, is_required, sort_order, auto_fill_source)
select md.id, 'trucking', q.question_text, q.field_type, q.is_required, q.sort_order, q.auto_fill_source
from public.market_directory md
cross join (values
  ('Has the applicant been cancelled or non-renewed in the last three years?', 'yes_no', true, 10, null),
  ('Any lapse in coverage in the past three years?', 'yes_no', true, 11, null),
  ('Transport hazardous materials?', 'yes_no', true, 12, null),
  ('Does the applicant use team drivers or slip seating?', 'yes_no', false, 13, null),
  ('Does the insured rent any units on a short term basis?', 'yes_no', false, 14, null),
  ('Refrigeration Breakdown coverage needed?', 'yes_no', false, 15, null),
  ('Trailer Interchange coverage needed?', 'yes_no', false, 16, null),
  ('Hired Auto Liability needed?', 'yes_no', false, 17, null)
) as q(question_text, field_type, is_required, sort_order, auto_fill_source)
where md.name = 'JSA'
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. UPDATE MARKET DIRECTORY WITH SUBMISSION INFO FROM OFFICIAL FORMS
-- ═══════════════════════════════════════════════════════════════════════════════

update public.market_directory
set
  submission_email = 'newsubmissions@truckers-insurance.com',
  portal_url = 'https://www.truckers-insurance.com/quote',
  submission_instructions = 'Completed forms can be submitted via email to newsubmissions@truckers-insurance.com or online at www.truckers-insurance.com/quote.',
  updated_at = now()
where name = 'Truckers Insurance Associates / TIA';

update public.market_directory
set
  website_url = 'https://jsausa.com',
  phone = '800-342-5572',
  submission_instructions = 'Submit completed application to JSA. North Carolina, South Carolina, Virginia, Georgia, Tennessee, Maryland coverage territory. PO Box 2540 Boone, NC 28607.',
  territory_notes = 'North Carolina, South Carolina, Virginia, Georgia, Tennessee, Maryland',
  underwriting_notes = 'For Commodities note that no more than 15% can be used for "General Dry Freight". CDL experience begins when the full CDL is obtained, not the permit.',
  updated_at = now()
where name = 'JSA';

commit;
