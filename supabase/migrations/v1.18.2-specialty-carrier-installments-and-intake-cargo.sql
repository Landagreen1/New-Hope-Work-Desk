-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.18.2 — Specialty Carrier Installment Fields + Intake Cargo in Detail RPC
--
-- Changes:
--   1. Add installment_count + installment_amount to specialty_carrier_markets
--   2. Update specialty_opportunity_detail to include new cargo/commodity fields
--      and the cs_intake_commodities child table in the intake payload
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. INSTALLMENT FIELDS on specialty_carrier_markets
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.specialty_carrier_markets
  add column if not exists installment_count integer;

alter table public.specialty_carrier_markets
  add column if not exists installment_amount numeric(12,2);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. UPDATE specialty_opportunity_detail
--    - Include new cargo/commodity fields from cs_intake_submissions
--    - Include cs_intake_commodities in the intake payload
--    - Include installment_count + installment_amount in carrier_markets
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_opportunity_detail(p_opportunity_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
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

    -- The linked intake, read live. Now includes cargo/commodity fields from v1.18.0+
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
          'property_address_street', s.property_address_street,
          'property_address_city', s.property_address_city,
          'property_address_state', s.property_address_state,
          'property_address_zip', s.property_address_zip,
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
          'commodities', coalesce((
            select jsonb_agg(jsonb_build_object(
              'category', co.category, 'frequency', co.frequency, 'is_primary', co.is_primary
            ) order by co.is_primary desc, co.category)
            from public.cs_intake_commodities co where co.submission_id = s.id), '[]'::jsonb)
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
$fn$;

comment on function public.specialty_opportunity_detail(uuid) is
  'Everything the specialty detail drawer needs, in one round trip. Includes cargo/commodity classification fields (v1.18.0+), installment data on carriers (v1.18.2), and commodities child records.';

revoke execute on function public.specialty_opportunity_detail(uuid) from public, anon;
grant execute on function public.specialty_opportunity_detail(uuid) to authenticated;

commit;
