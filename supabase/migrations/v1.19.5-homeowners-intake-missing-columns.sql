-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.19.5 — Homeowners intake: the six columns the form was already collecting
--
-- Submitting a Homeowners intake failed with:
--   "Could not find the 'coverage_type' column of 'cs_intake_submissions'
--    in the schema cache"
--
-- Cause. `HomeownersSection` collects six fields that were never added to
-- `cs_intake_submissions`: the Type of Coverage dropdown, the verified-address
-- trio behind the property address control (unit / place id / formatted /
-- verified) and the free-text Last Roof Update. `IntakeForm` maps all six into
-- the submission payload.
--
-- Only a *brand-new* intake surfaced the error, because `saveDraft` inserts the
-- first version directly through PostgREST while every later save goes through
-- `cs_intake_save_draft`, which filters the payload against
-- `information_schema.columns` and silently discards unknown keys. So a new
-- Homeowners intake errored out and an existing one quietly lost the answers.
--
-- Fix. Add the columns rather than delete the fields: Customer Service is
-- already being asked for this information on every homeowners call, the
-- property address control depends on `property_addr_verified` to know whether
-- Google actually confirmed the address, and Type of Coverage is a required
-- field in the form. Then teach the Specialty read/write functions about them,
-- so the quoting team sees what CS typed instead of a write-only column.
--
-- Naming follows the two address blocks already on this table (`addr_unit`,
-- `addr_place_id`, `addr_formatted`, `addr_verified` and the `renters_*` set),
-- and matches the keys the frontend already sends, so no client rename is
-- needed.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. COLUMNS
-- ─────────────────────────────────────────────────────────────────────────────

-- Policy form the customer is asking for: Homeowners / Landlord / Mobile Home.
-- Deliberately unconstrained: the option list lives in the form and has changed
-- once already, and a rejected insert is a worse outcome than an unexpected
-- label on a quote that a human is about to read anyway.
alter table public.cs_intake_submissions
  add column if not exists coverage_type varchar(50);

-- Property address: the parts of the verified-address control that had nowhere
-- to land. Without these the unit number was dropped and every reopened draft
-- claimed the address had never been verified.
alter table public.cs_intake_submissions
  add column if not exists property_address_unit text;
alter table public.cs_intake_submissions
  add column if not exists property_place_id text;
alter table public.cs_intake_submissions
  add column if not exists property_formatted text;
alter table public.cs_intake_submissions
  add column if not exists property_addr_verified boolean not null default false;

-- Free text on purpose. The field is a plain input with an "e.g. 2020"
-- placeholder, so customers answer "2020", "about 5 years ago" or "roof is
-- original" and a date column would reject two of those three.
alter table public.cs_intake_submissions
  add column if not exists last_roof_update text;

comment on column public.cs_intake_submissions.coverage_type is
  'Homeowners policy form requested: Homeowners, Landlord or Mobile Home.';
comment on column public.cs_intake_submissions.property_addr_verified is
  'True when the homeowners property address was confirmed by address lookup rather than typed by hand.';
comment on column public.cs_intake_submissions.last_roof_update is
  'Free-text answer to "last roof update" — a year, an approximation, or a note.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. specialty_opportunity_detail — return the new fields to the quoting team
--    Only the homeowners jsonb chunk changes; everything else is the live
--    v1.19.4 body, reproduced so this file is the whole definition.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.specialty_opportunity_detail(p_opportunity_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_row public.specialty_opportunity_rows;
  v_result jsonb;
begin
  if not public.specialty_can_view_opportunity(p_opportunity_id) then
    raise exception 'That specialty quote is not available for your account.' using errcode = '42501';
  end if;

  select * into v_row from public.specialty_opportunity_rows where id = p_opportunity_id;
  if not found then raise exception 'That specialty quote could not be found.'; end if;

  select jsonb_build_object(
    'opportunity', to_jsonb(v_row) - 'search_blob' - 'phone_digits' - 'phone_alt_digits' - 'carrier_names',
    'can_edit', public.specialty_can_edit_opportunity(p_opportunity_id),
    'can_reassign', public.specialty_can_reassign_opportunity(p_opportunity_id),
    'is_manager', public.specialty_is_manager(),

    'carrier_markets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'carrier_id', m.carrier_id, 'carrier_name', c.name,
        'market_directory_id', c.market_directory_id,
        'status', m.status,
        'handled_by', m.handled_by, 'handled_by_name', handler.display_name,
        'submitted_at', m.submitted_at, 'submitted_by', m.submitted_by,
        'submitted_by_name', submitter.display_name,
        'last_action_at', m.last_action_at, 'last_action_by_name', actor.display_name,
        'follow_up_date', m.follow_up_date,
        'premium', m.premium, 'down_payment', m.down_payment,
        'payment_terms', m.payment_terms, 'deductible', m.deductible,
        'coverage_notes', m.coverage_notes,
        'installment_count', m.installment_count,
        'installment_amount', m.installment_amount,
        'quote_number', m.quote_number,
        'quote_received_at', m.quote_received_at,
        'quote_received_by_name', receiver.display_name,
        'decline_reason', m.decline_reason, 'info_requested', m.info_requested,
        'notes', m.notes, 'presented_at', m.presented_at,
        'document_count', (select count(*) from public.specialty_documents d
                            where d.carrier_market_id = m.id),
        'version', m.version
      ) order by
        case m.status when 'quote_received' then 0 when 'more_info_needed' then 1
                      when 'waiting' then 2 when 'submitted' then 3 when 'preparing' then 4
                      when 'not_started' then 5 when 'not_competitive' then 6
                      when 'declined' then 7 else 8 end,
        m.premium nulls last, c.name)
      from public.specialty_carrier_markets m
      join public.specialty_carriers c on c.id = m.carrier_id
      left join public.profiles handler on handler.id = m.handled_by
      left join public.profiles submitter on submitter.id = m.submitted_by
      left join public.profiles receiver on receiver.id = m.quote_received_by
      left join public.profiles actor on actor.id = m.last_action_by
      where m.opportunity_id = p_opportunity_id
    ), '[]'::jsonb),

    'checklist', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'category', i.category, 'label', i.label, 'position', i.position,
        'is_required', i.is_required, 'is_custom', i.is_custom,
        'is_checked', i.is_checked, 'checked_at', i.checked_at,
        'checked_by_name', checker.display_name
      ) order by i.position, i.label)
      from public.specialty_checklist_items i
      left join public.profiles checker on checker.id = i.checked_by
      where i.opportunity_id = p_opportunity_id
    ), '[]'::jsonb),

    'information_requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'label', r.label, 'status', r.status, 'note', r.note,
        'visible_to_cs', r.visible_to_cs,
        'requested_at', r.requested_at, 'requested_by_name', requester.display_name,
        'resolved_at', r.resolved_at, 'resolved_by_name', resolver.display_name
      ) order by
        case r.status when 'needed' then 0 when 'requested' then 1 else 2 end,
        r.created_at)
      from public.specialty_information_requests r
      left join public.profiles requester on requester.id = r.requested_by
      left join public.profiles resolver on resolver.id = r.resolved_by
      where r.opportunity_id = p_opportunity_id
    ), '[]'::jsonb),

    'notes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id, 'content', n.content, 'created_at', n.created_at,
        'author_id', n.author_id, 'author_name', author.display_name,
        'author_initials', author.initials,
        'carrier_market_id', n.carrier_market_id, 'is_cs_visible', n.is_cs_visible
      ) order by n.created_at desc)
      from public.specialty_notes n
      left join public.profiles author on author.id = n.author_id
      where n.opportunity_id = p_opportunity_id
    ), '[]'::jsonb),

    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'file_name', d.file_name, 'file_size', d.file_size,
        'mime_type', d.mime_type, 'category', d.category,
        'storage_bucket', d.storage_bucket, 'storage_path', d.storage_path,
        'carrier_market_id', d.carrier_market_id,
        'uploaded_by', d.uploaded_by, 'uploaded_by_name', uploader.display_name,
        'created_at', d.created_at,
        'is_legacy', d.storage_bucket <> 'specialty-quote-documents'
      ) order by d.created_at desc)
      from public.specialty_documents d
      left join public.profiles uploader on uploader.id = d.uploaded_by
      where d.opportunity_id = p_opportunity_id
    ), '[]'::jsonb),

    'price_presentations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pp.id, 'presented_at', pp.presented_at, 'method', pp.method,
        'note', pp.note, 'options', pp.options,
        'presented_by', pp.presented_by, 'presented_by_name', presenter.display_name
      ) order by pp.presented_at desc)
      from public.specialty_price_presentations pp
      left join public.profiles presenter on presenter.id = pp.presented_by
      where pp.opportunity_id = p_opportunity_id
    ), '[]'::jsonb),

    'contributors', coalesce((
      select jsonb_agg(x order by x ->> 'display_name')
      from (
        select jsonb_build_object(
          'profile_id', a.actor_profile_id,
          'display_name', p.display_name,
          'initials', p.initials,
          'action_count', count(*),
          'last_action_at', max(a.created_at),
          'is_primary_assignee', a.actor_profile_id = v_row.primary_assignee_id
        ) as x
        from public.specialty_activity a
        join public.profiles p on p.id = a.actor_profile_id
        where a.opportunity_id = p_opportunity_id
          and a.actor_profile_id is not null
        group by a.actor_profile_id, p.display_name, p.initials
      ) contributors
    ), '[]'::jsonb),

    -- The linked intake, read live. Includes the cargo fields from v1.18.0+ and
    -- the full underwriting set from v1.19.2.
    'intake', (
      select
        jsonb_build_object(
          'id', s.id, 'status', s.status::text, 'line_of_business', s.line_of_business::text,
          'version', s.version,
          'insured_first_name', s.insured_first_name,
          'insured_middle_name', s.insured_middle_name,
          'insured_last_name', s.insured_last_name,
          'insured_dob', s.insured_dob,
          'insured_email', s.insured_email,
          'insured_phone_primary', s.insured_phone_primary,
          'insured_phone_alt', s.insured_phone_alt,
          'preferred_language', s.preferred_language,
          'preferred_contact', s.preferred_contact,
          'addr_street', s.addr_street, 'addr_unit', s.addr_unit,
          'addr_city', s.addr_city, 'addr_state', s.addr_state, 'addr_zip', s.addr_zip,
          'created_by_name', ic.display_name,
          'submitted_at', s.submitted_at
        )
        || jsonb_build_object(
          'current_carrier', s.current_carrier,
          'current_policy_number', s.current_policy_number,
          'current_premium', s.current_premium,
          'current_expiration', s.current_expiration,
          'prior_insurance', s.prior_insurance, 'prior_lapse', s.prior_lapse,
          'csr_notes', s.csr_notes,
          'desired_coverage', s.desired_coverage, 'liability_limit', s.liability_limit,
          'comprehensive_deductible', s.comprehensive_deductible,
          'collision_deductible', s.collision_deductible,
          'business_name', s.business_name, 'business_type', s.business_type,
          'years_in_business', s.years_in_business,
          'dot_number', s.dot_number, 'mc_number', s.mc_number,
          'mcs150_date', s.mcs150_date, 'cargo_type', s.cargo_type,
          'power_unit_count', s.power_unit_count,
          'operating_radius_miles', s.operating_radius_miles,
          'states_of_operation', s.states_of_operation
        )
        || jsonb_build_object(
          -- New cargo/commodity fields (v1.18.0+)
          'primary_commodity', s.primary_commodity,
          'cargo_description', s.cargo_description,
          'broker_load_board', s.broker_load_board,
          'commodity_mix_known', s.commodity_mix_known,
          'typical_load_value', s.typical_load_value,
          'max_load_value', s.max_load_value,
          'requested_cargo_limit', s.requested_cargo_limit,
          'cargo_deductible', s.cargo_deductible,
          'refrigerated', s.refrigerated,
          'temperature_controlled_equipment', s.temperature_controlled_equipment,
          'reefer_breakdown_requested', s.reefer_breakdown_requested,
          'hazmat', s.hazmat,
          'high_value_cargo_flag', s.high_value_cargo_flag,
          'cargo_coverage_desired', s.cargo_coverage_desired,
          'excluded_cargo', s.excluded_cargo
        )
        || jsonb_build_object(
          -- Trucking operations, requested coverages and underwriting (v1.19.2).
          -- Kept in its own chunk to stay under the 100-argument ceiling on
          -- jsonb_build_object.
          'ein', s.ein,
          'months_continuous_coverage', s.months_continuous_coverage,
          'operation_types', s.operation_types,
          'operation_description', s.operation_description,
          'desired_effective_date', s.desired_effective_date,
          'interstate', s.interstate,
          'for_hire', s.for_hire,
          'radius_band', s.radius_band,
          'farthest_states_cities', s.farthest_states_cities,
          'auto_liability_limit', s.auto_liability_limit,
          'auto_liability_limit_other', s.auto_liability_limit_other,
          'um_uim_limit', s.um_uim_limit,
          'hired_auto', s.hired_auto,
          'non_owned_auto', s.non_owned_auto,
          'physical_damage_needed', s.physical_damage_needed,
          'physical_damage_deductible_requested', s.physical_damage_deductible_requested,
          'pd_comprehensive', s.pd_comprehensive,
          'pd_collision', s.pd_collision,
          'pd_specified_causes', s.pd_specified_causes,
          'pulls_non_owned_trailers', s.pulls_non_owned_trailers,
          'trailer_interchange_agreement', s.trailer_interchange_agreement,
          'trailer_interchange_limit', s.trailer_interchange_limit,
          'trailer_interchange_deductible', s.trailer_interchange_deductible,
          'general_liability_requested', s.general_liability_requested,
          'general_liability_limit', s.general_liability_limit,
          'medical_payments_requested', s.medical_payments_requested,
          'medical_payments_limit', s.medical_payments_limit,
          'additional_coverages_other', s.additional_coverages_other,
          'uw_coverage_lapse', s.uw_coverage_lapse,
          'uw_coverage_lapse_detail', s.uw_coverage_lapse_detail,
          'uw_cancelled_nonrenewed', s.uw_cancelled_nonrenewed,
          'uw_cancelled_nonrenewed_detail', s.uw_cancelled_nonrenewed_detail,
          'uw_losses_3yr', s.uw_losses_3yr,
          'uw_losses_3yr_detail', s.uw_losses_3yr_detail,
          'uw_major_al_loss', s.uw_major_al_loss,
          'uw_major_al_loss_detail', s.uw_major_al_loss_detail,
          'hazmat_detail', s.hazmat_detail,
          'uw_owner_operators', s.uw_owner_operators,
          'uw_owner_operators_detail', s.uw_owner_operators_detail,
          'owner_operator_count', s.owner_operator_count,
          'owns_or_leases_trailers', s.owns_or_leases_trailers,
          'prior_lapse_explanation', s.prior_lapse_explanation
        )
        || jsonb_build_object(
          'property_address_street', s.property_address_street,
          -- New in v1.19.5. The unit and the verified-address trio were being
          -- collected by Customer Service and thrown away.
          'property_address_unit', s.property_address_unit,
          'property_address_city', s.property_address_city,
          'property_address_state', s.property_address_state,
          'property_address_zip', s.property_address_zip,
          'property_place_id', s.property_place_id,
          'property_formatted', s.property_formatted,
          'property_addr_verified', s.property_addr_verified,
          'coverage_type', s.coverage_type,
          'last_roof_update', s.last_roof_update,
          'dwelling_type', s.dwelling_type, 'year_built', s.year_built,
          'square_footage', s.square_footage, 'roof_type', s.roof_type,
          'roof_age', s.roof_age, 'coverage_amount', s.coverage_amount,
          'prior_claims', s.prior_claims, 'prior_claims_detail', s.prior_claims_detail,
          'drivers', coalesce((
            select jsonb_agg(to_jsonb(dr) order by dr.position)
            from public.cs_intake_drivers dr where dr.submission_id = s.id), '[]'::jsonb),
          'vehicles', coalesce((
            select jsonb_agg(to_jsonb(ve) order by ve.position)
            from public.cs_intake_vehicles ve where ve.submission_id = s.id), '[]'::jsonb),
          'owners', coalesce((
            select jsonb_agg(to_jsonb(ow) order by ow.position)
            from public.cs_intake_owners ow where ow.submission_id = s.id), '[]'::jsonb),
          -- Now carries the per-commodity percent and values added in v1.19.2.
          'commodities', coalesce((
            select jsonb_agg(jsonb_build_object(
              'category', co.category, 'frequency', co.frequency, 'is_primary', co.is_primary,
              'percent_hauled', co.percent_hauled,
              'average_value', co.average_value,
              'maximum_value', co.maximum_value
            ) order by co.is_primary desc, co.category)
            from public.cs_intake_commodities co where co.submission_id = s.id), '[]'::jsonb),
          -- New in v1.19.2. Trailers rate separately from power units, so the
          -- carrier Trailer Information table needs its own rows.
          'trailers', coalesce((
            select jsonb_agg(to_jsonb(tr) order by tr.position)
            from public.cs_intake_trailers tr where tr.submission_id = s.id), '[]'::jsonb)
        )
      from public.cs_intake_submissions s
      left join public.profiles ic on ic.id = s.created_by
      where s.id = v_row.source_intake_id
    ),

    'workflow_stages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'stage_key', w.stage_key, 'label', w.label, 'position', w.position,
        'requires_next_action', w.requires_next_action, 'is_terminal', w.is_terminal
      ) order by w.position)
      from public.specialty_workflow_stages w
      where w.template_id = v_row.workflow_template_id
    ), '[]'::jsonb),

    'assignable_members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'profile_id', p.id, 'display_name', p.display_name, 'initials', p.initials
      ) order by p.display_name)
      from public.quoting_team_members m
      join public.profiles p on p.id = m.profile_id
      where m.team_id = v_row.team_id and m.is_active and m.can_be_assigned and p.is_active
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. specialty_update_intake — let the quoting team correct the new fields
--    Same body as live, with the six columns added to the allow-list and to the
--    update tuple. `property_address_unit` and `property_addr_verified` are
--    included because a specialty member who fixes the street line must be able
--    to fix the apartment number and to clear a verified flag that no longer
--    describes the address they just typed.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.specialty_update_intake(
  p_opportunity_id uuid,
  p_patch jsonb default '{}'::jsonb,
  p_drivers jsonb default null::jsonb,
  p_vehicles jsonb default null::jsonb,
  p_expected_intake_version integer default null::integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_row public.specialty_opportunities;
  v_intake public.cs_intake_submissions;
  v_key text;
  v_allowed text[] := array[
    -- Customer contact
    'insured_first_name', 'insured_middle_name', 'insured_last_name', 'insured_dob',
    'insured_email', 'insured_phone_primary', 'insured_phone_alt',
    'preferred_language', 'preferred_contact',
    'addr_street', 'addr_unit', 'addr_city', 'addr_state', 'addr_zip',
    -- Current policy
    'current_carrier', 'current_policy_number', 'current_premium', 'current_expiration',
    'prior_insurance', 'prior_lapse', 'csr_notes',
    -- Trucking
    'business_name', 'business_type', 'years_in_business', 'dot_number', 'mc_number',
    'mcs150_date', 'cargo_type', 'power_unit_count', 'operating_radius_miles',
    'states_of_operation',
    -- Homeowners
    'property_address_street', 'property_address_unit', 'property_address_city',
    'property_address_state', 'property_address_zip',
    'property_place_id', 'property_formatted', 'property_addr_verified',
    'coverage_type', 'last_roof_update',
    'dwelling_type', 'year_built', 'square_footage',
    'roof_type', 'roof_age', 'coverage_amount', 'prior_claims', 'prior_claims_detail',
    -- Coverage
    'desired_coverage', 'liability_limit', 'comprehensive_deductible', 'collision_deductible'
  ];
  v_updated_keys text[] := '{}';
begin
  if not public.specialty_can_edit_opportunity(p_opportunity_id) then
    raise exception 'You cannot edit this specialty quote.' using errcode = '42501';
  end if;

  select * into v_row from public.specialty_opportunities where id = p_opportunity_id;
  if not found then raise exception 'That specialty quote could not be found.'; end if;
  if v_row.source_intake_id is null then
    raise exception 'This quote has no linked intake to edit.';
  end if;

  select * into v_intake from public.cs_intake_submissions
   where id = v_row.source_intake_id for update;
  if not found then raise exception 'The linked intake could not be found.'; end if;

  if p_expected_intake_version is not null and v_intake.version <> p_expected_intake_version then
    raise exception 'This customer information was updated by another employee while you were working on it. Review the latest information before saving.'
      using errcode = '40001';
  end if;

  for v_key in select jsonb_object_keys(coalesce(p_patch, '{}')) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'Field % cannot be changed from Specialty Quotes.', v_key;
    end if;
    v_updated_keys := v_updated_keys || v_key;
  end loop;

  if array_length(v_updated_keys, 1) > 0 then
    -- jsonb_populate_record applies only the supplied keys; absent keys keep the
    -- stored value, so this is a patch and not a full overwrite.
    update public.cs_intake_submissions s
       set (insured_first_name, insured_middle_name, insured_last_name, insured_dob,
            insured_email, insured_phone_primary, insured_phone_alt,
            preferred_language, preferred_contact,
            addr_street, addr_unit, addr_city, addr_state, addr_zip,
            current_carrier, current_policy_number, current_premium, current_expiration,
            prior_insurance, prior_lapse, csr_notes,
            business_name, business_type, years_in_business, dot_number, mc_number,
            mcs150_date, cargo_type, power_unit_count, operating_radius_miles,
            states_of_operation,
            property_address_street, property_address_unit, property_address_city,
            property_address_state, property_address_zip,
            property_place_id, property_formatted, property_addr_verified,
            coverage_type, last_roof_update,
            dwelling_type, year_built, square_footage,
            roof_type, roof_age, coverage_amount, prior_claims, prior_claims_detail,
            desired_coverage, liability_limit, comprehensive_deductible, collision_deductible)
         = (select p.insured_first_name, p.insured_middle_name, p.insured_last_name, p.insured_dob,
                   p.insured_email, p.insured_phone_primary, p.insured_phone_alt,
                   p.preferred_language, p.preferred_contact,
                   p.addr_street, p.addr_unit, p.addr_city, p.addr_state, p.addr_zip,
                   p.current_carrier, p.current_policy_number, p.current_premium, p.current_expiration,
                   p.prior_insurance, p.prior_lapse, p.csr_notes,
                   p.business_name, p.business_type, p.years_in_business, p.dot_number, p.mc_number,
                   p.mcs150_date, p.cargo_type, p.power_unit_count, p.operating_radius_miles,
                   p.states_of_operation,
                   p.property_address_street, p.property_address_unit, p.property_address_city,
                   p.property_address_state, p.property_address_zip,
                   p.property_place_id, p.property_formatted, p.property_addr_verified,
                   p.coverage_type, p.last_roof_update,
                   p.dwelling_type, p.year_built, p.square_footage,
                   p.roof_type, p.roof_age, p.coverage_amount, p.prior_claims, p.prior_claims_detail,
                   p.desired_coverage, p.liability_limit, p.comprehensive_deductible, p.collision_deductible
            from jsonb_populate_record(v_intake, p_patch) p),
           last_edited_by = auth.uid(),
           last_edited_at = now(),
           version = s.version + 1,
           updated_at = now()
     where s.id = v_intake.id;
  end if;

  -- Vehicles and drivers are replace-all when supplied, matching how the intake
  -- form itself saves them, and untouched when the argument is null.
  if p_vehicles is not null then
    delete from public.cs_intake_vehicles where submission_id = v_intake.id;
    insert into public.cs_intake_vehicles
      (submission_id, position, year, make, model, vin, vin_pending, ownership,
       lienholder, usage, annual_mileage, garaging_zip, coverage)
    select v_intake.id,
           coalesce((r ->> 'position')::integer, ordinality::integer),
           nullif(r ->> 'year', '')::integer, nullif(r ->> 'make', ''), nullif(r ->> 'model', ''),
           nullif(r ->> 'vin', ''), coalesce((r ->> 'vin_pending')::boolean, false),
           nullif(r ->> 'ownership', ''), nullif(r ->> 'lienholder', ''), nullif(r ->> 'usage', ''),
           nullif(r ->> 'annual_mileage', '')::integer, nullif(r ->> 'garaging_zip', ''),
           coalesce(r -> 'coverage', '{}'::jsonb)
    from jsonb_array_elements(p_vehicles) with ordinality as t(r, ordinality);
    v_updated_keys := v_updated_keys || 'vehicles';
  end if;

  if p_drivers is not null then
    delete from public.cs_intake_drivers where submission_id = v_intake.id;
    insert into public.cs_intake_drivers
      (submission_id, position, first_name, last_name, dob, relationship, document_type,
       license_number, license_state, license_status, years_licensed, sr22_required, incidents)
    select v_intake.id,
           coalesce((r ->> 'position')::integer, ordinality::integer),
           coalesce(r ->> 'first_name', ''), coalesce(r ->> 'last_name', ''),
           nullif(r ->> 'dob', '')::date, nullif(r ->> 'relationship', ''),
           coalesce(nullif(r ->> 'document_type', ''), 'driver_license'),
           nullif(r ->> 'license_number', ''), nullif(r ->> 'license_state', ''),
           nullif(r ->> 'license_status', ''), nullif(r ->> 'years_licensed', '')::integer,
           coalesce((r ->> 'sr22_required')::boolean, false),
           coalesce(r -> 'incidents', '[]'::jsonb)
    from jsonb_array_elements(p_drivers) with ordinality as t(r, ordinality);
    v_updated_keys := v_updated_keys || 'drivers';
  end if;

  if array_length(v_updated_keys, 1) is null then
    return jsonb_build_object('version', v_intake.version, 'fields', '[]'::jsonb);
  end if;

  -- Both logs, because both audiences need it: Customer Service reads the intake's
  -- own history, the specialty team reads the opportunity timeline.
  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (v_intake.id, auth.uid(), 'specialty_edit', jsonb_build_object(
    'opportunity_id', p_opportunity_id,
    'reference', v_row.reference,
    'fields', to_jsonb(v_updated_keys)
  ));

  perform public.specialty_log(p_opportunity_id, 'field_updated', jsonb_build_object(
    'target', 'intake',
    'fields', to_jsonb(v_updated_keys)
  ));

  update public.specialty_opportunities
     set last_activity_at = now() where id = p_opportunity_id;

  return jsonb_build_object('version', v_intake.version + 1, 'fields', to_jsonb(v_updated_keys));
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. VERIFY — fail loudly rather than leave a half-applied migration
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_missing text;
begin
  select string_agg(want, ', ')
  into v_missing
  from unnest(array[
    'coverage_type', 'property_address_unit', 'property_place_id',
    'property_formatted', 'property_addr_verified', 'last_roof_update'
  ]) as want
  where not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'cs_intake_submissions'
      and c.column_name = want
  );

  if v_missing is not null then
    raise exception 'v1.19.5 did not add: %', v_missing;
  end if;

  raise notice 'v1.19.5: all six homeowners intake columns present.';
end;
$$;

-- PostgREST caches the schema. Without this the new columns stay invisible to
-- the client insert that was failing, which is the entire point of the fix.
notify pgrst, 'reload schema';
