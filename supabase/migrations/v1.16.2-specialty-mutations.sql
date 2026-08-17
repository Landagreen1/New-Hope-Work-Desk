-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.16.2 — Specialty Quotes: the transitions
--
-- Spec: sections 12-18, 23, 28-36, 40-48, 88, 91.
-- Requires v1.16.1.
--
-- WHAT THIS CHANGES
--   Every state transition an employee can perform, as a security definer RPC that
--   validates, stamps server timestamps, writes the activity row with the ACTUAL
--   actor, and bumps the optimistic-concurrency version — all in one transaction.
--
--   Three rules are enforced here and nowhere else:
--     * Claiming is atomic. The row is locked before the assignee is read, so two
--       simultaneous clicks produce one winner and one clear message (spec 16).
--     * A stale save is refused, not merged. p_expected_version must match (14).
--     * Not Sold requires a reason from the vocabulary (34).
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
--   No rotation. Specialty work is claimed from a shared team pool and has no
--   relationship to the WhatsApp, RingCentral or Additional Workload rotations.
--   Nothing in this file reads or writes rotation_state or turn_events, and
--   nothing here may be given a rotation side effect later without revisiting the
--   queue-rotation rules.
--
-- ROLLBACK: drop each function named below. No table or policy is altered.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. INTERNAL HELPERS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Records one activity entry. actor_profile_id is always auth.uid(): the employee
-- who performed the action, never the primary assignee (spec sections 12, 13, 91).
create or replace function public.specialty_log(
  p_opportunity_id uuid,
  p_event_type text,
  p_detail jsonb default '{}',
  p_carrier_market_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.specialty_activity
    (opportunity_id, carrier_market_id, actor_profile_id, event_type, detail)
  values (p_opportunity_id, p_carrier_market_id, auth.uid(), p_event_type, coalesce(p_detail, '{}'))
  returning id into v_id;
  return v_id;
end;
$$;

comment on function public.specialty_log(uuid, text, jsonb, uuid) is
  'Appends one activity row attributed to the calling user. Internal to the specialty RPCs; not granted to authenticated so a client cannot forge history.';

revoke all on function public.specialty_log(uuid, text, jsonb, uuid) from public, anon, authenticated;

-- Loads and locks an opportunity the caller may edit, checking the version.
-- Raising 40001 for a version mismatch matches cs_intake_save_draft, so the client
-- can recognise a conflict the same way it already does for shared intake drafts.
create or replace function public.specialty_lock_for_edit(
  p_opportunity_id uuid,
  p_expected_version integer default null
)
returns public.specialty_opportunities
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.specialty_opportunities;
begin
  if not public.specialty_can_edit_opportunity(p_opportunity_id) then
    raise exception 'You cannot edit this specialty quote.' using errcode = '42501';
  end if;

  select * into v_row
  from public.specialty_opportunities
  where id = p_opportunity_id
  for update;

  if not found then
    raise exception 'That specialty quote could not be found.';
  end if;

  if p_expected_version is not null and v_row.version <> p_expected_version then
    raise exception 'This quote was updated by another employee while you were working on it. Review the latest information before saving.'
      using errcode = '40001';
  end if;

  return v_row;
end;
$$;

revoke all on function public.specialty_lock_for_edit(uuid, integer) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. CLAIM  (spec sections 15, 16)
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_claim_opportunity(p_opportunity_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.specialty_opportunities;
  v_team public.quoting_teams;
  v_holder text;
begin
  if not public.specialty_can_claim_opportunity(p_opportunity_id) then
    raise exception 'You are not eligible to claim this specialty quote.' using errcode = '42501';
  end if;

  -- The lock comes BEFORE the assignee is read. Two members clicking Claim at the
  -- same moment serialise here, so the second one sees the first one's name rather
  -- than overwriting it.
  select * into v_row
  from public.specialty_opportunities
  where id = p_opportunity_id
  for update;

  if not found then raise exception 'That specialty quote could not be found.'; end if;

  select * into v_team from public.quoting_teams where id = v_row.team_id;
  if not v_team.is_active then
    raise exception 'That quoting team is not active.';
  end if;

  if v_team.assignment_method = 'manual_assignment' and not public.specialty_is_manager() then
    raise exception 'This team assigns work manually. A manager or team lead assigns this quote.';
  end if;

  if v_row.primary_assignee_id is not null then
    if v_row.primary_assignee_id = auth.uid() then
      return jsonb_build_object('claimed', false, 'already_mine', true,
                                'assignee_id', v_row.primary_assignee_id, 'version', v_row.version);
    end if;
    select display_name into v_holder from public.profiles where id = v_row.primary_assignee_id;
    raise exception 'This quote has already been claimed by %.', coalesce(v_holder, 'another employee');
  end if;

  -- Only a member the team allows to be assigned may become the assignee. A manager
  -- claiming on someone's behalf uses Transfer instead.
  if not public.specialty_member_capability(v_row.team_id, 'assign') and not public.specialty_is_manager() then
    raise exception 'You cannot be assigned work on this team.' using errcode = '42501';
  end if;

  perform set_config('specialty.privileged', 'on', true);

  update public.specialty_opportunities
     set primary_assignee_id = auth.uid(),
         claimed_at = now(),
         version = version + 1,
         last_activity_at = now()
   where id = p_opportunity_id;

  perform set_config('specialty.privileged', 'off', true);

  perform public.specialty_log(p_opportunity_id, 'claimed', jsonb_build_object(
    'assignee_id', auth.uid(),
    'stage', v_row.stage,
    'seconds_unclaimed', greatest(0, extract(epoch from (now() - v_row.created_at))::integer)
  ));

  return jsonb_build_object('claimed', true, 'assignee_id', auth.uid(), 'version', v_row.version + 1);
end;
$$;

comment on function public.specialty_claim_opportunity(uuid) is
  'Takes primary responsibility for an unclaimed opportunity. Atomic: the row is locked before the assignee is read, so a simultaneous second claim is refused with the winner''s name. Claiming establishes accountability only — the opportunity stays fully visible and editable to every eligible team member. Spec sections 15, 16.';

grant execute on function public.specialty_claim_opportunity(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. REASSIGN  (spec section 17)
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_reassign_opportunity(
  p_opportunity_id uuid,
  p_profile_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.specialty_opportunities;
  v_previous uuid;
begin
  if not public.specialty_can_reassign_opportunity(p_opportunity_id) then
    raise exception 'You cannot transfer this specialty quote.' using errcode = '42501';
  end if;

  select * into v_row from public.specialty_opportunities where id = p_opportunity_id for update;
  if not found then raise exception 'That specialty quote could not be found.'; end if;

  v_previous := v_row.primary_assignee_id;

  if p_profile_id is not null then
    if not exists (
      select 1
      from public.quoting_team_members m
      join public.profiles p on p.id = m.profile_id
      where m.team_id = v_row.team_id
        and m.profile_id = p_profile_id
        and m.is_active and m.can_be_assigned
        and p.is_active
    ) then
      raise exception 'That employee cannot be assigned work on this team.';
    end if;
  end if;

  if v_previous is not distinct from p_profile_id then
    return jsonb_build_object('changed', false, 'assignee_id', v_previous, 'version', v_row.version);
  end if;

  perform set_config('specialty.privileged', 'on', true);

  update public.specialty_opportunities
     set primary_assignee_id = p_profile_id,
         claimed_at = case when p_profile_id is null then null else coalesce(claimed_at, now()) end,
         version = version + 1,
         last_activity_at = now()
   where id = p_opportunity_id;

  perform set_config('specialty.privileged', 'off', true);

  -- Previous assignee, new assignee, who changed it, when. All four, always.
  perform public.specialty_log(
    p_opportunity_id,
    case when p_profile_id is null then 'unassigned' else 'reassigned' end,
    jsonb_build_object(
      'previous_assignee_id', v_previous,
      'new_assignee_id', p_profile_id,
      'reason', nullif(btrim(coalesce(p_reason, '')), '')
    ));

  if p_profile_id is not null then
    insert into public.user_notifications
      (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
    values (
      p_profile_id, 'assignment', 'Specialty quote assigned to you',
      v_row.display_name || ' (' || v_row.reference || ') is now assigned to you.',
      'specialty_opportunity', p_opportunity_id
    );
  end if;

  return jsonb_build_object('changed', true, 'previous_assignee_id', v_previous,
                            'assignee_id', p_profile_id, 'version', v_row.version + 1);
end;
$$;

comment on function public.specialty_reassign_opportunity(uuid, uuid, text) is
  'Explicit transfer of primary responsibility. Records previous assignee, new assignee, the user who changed it and the timestamp. Reassignment never happens as a side effect of an edit. Spec section 17.';

grant execute on function public.specialty_reassign_opportunity(uuid, uuid, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. COLLABORATIVE FIELD EDITS
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_update_opportunity(
  p_opportunity_id uuid,
  p_patch jsonb,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.specialty_opportunities;
  v_changed jsonb := '[]';
  v_key text;
  v_new text;
  v_old text;
begin
  v_row := public.specialty_lock_for_edit(p_opportunity_id, p_expected_version);

  -- The whitelist. Stage, assignment, pricing and result are absent on purpose:
  -- each has its own validated action.
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('display_name', 'priority', 'next_action', 'next_action_due') then
      raise exception 'Field % cannot be changed here.', v_key;
    end if;
  end loop;

  if p_patch ? 'display_name' then
    v_new := btrim(coalesce(p_patch ->> 'display_name', ''));
    if v_new = '' then raise exception 'A customer or business name is required.'; end if;
    if v_new is distinct from v_row.display_name then
      v_changed := v_changed || jsonb_build_object('field', 'display_name',
        'old_value', v_row.display_name, 'new_value', v_new);
      update public.specialty_opportunities set display_name = v_new where id = p_opportunity_id;
    end if;
  end if;

  if p_patch ? 'priority' then
    v_new := coalesce(p_patch ->> 'priority', 'normal');
    if v_new not in ('normal', 'high', 'urgent') then raise exception 'Unknown priority %.', v_new; end if;
    if v_new is distinct from v_row.priority then
      v_changed := v_changed || jsonb_build_object('field', 'priority',
        'old_value', v_row.priority, 'new_value', v_new);
      update public.specialty_opportunities set priority = v_new where id = p_opportunity_id;
      perform public.specialty_log(p_opportunity_id, 'priority_changed',
        jsonb_build_object('old_value', v_row.priority, 'new_value', v_new));
    end if;
  end if;

  if p_patch ? 'next_action' or p_patch ? 'next_action_due' then
    v_new := nullif(btrim(coalesce(p_patch ->> 'next_action', v_row.next_action, '')), '');
    v_old := v_row.next_action;
    update public.specialty_opportunities
       set next_action = v_new,
           next_action_due = case
             when p_patch ? 'next_action_due'
               then nullif(p_patch ->> 'next_action_due', '')::timestamptz
             else next_action_due end,
           next_action_set_by = auth.uid(),
           next_action_set_at = now()
     where id = p_opportunity_id;

    perform public.specialty_log(p_opportunity_id, 'next_action_set', jsonb_build_object(
      'old_value', v_old,
      'new_value', v_new,
      'due', case when p_patch ? 'next_action_due'
                  then nullif(p_patch ->> 'next_action_due', '')
                  else to_char(v_row.next_action_due, 'YYYY-MM-DD"T"HH24:MI:SSOF') end
    ));
  end if;

  if jsonb_array_length(v_changed) > 0 then
    perform public.specialty_log(p_opportunity_id, 'field_updated',
      jsonb_build_object('changes', v_changed));
  end if;

  update public.specialty_opportunities
     set version = version + 1, last_activity_at = now()
   where id = p_opportunity_id;

  return jsonb_build_object('version', v_row.version + 1, 'changes', v_changed);
end;
$$;

comment on function public.specialty_update_opportunity(uuid, jsonb, integer) is
  'Collaborative field edit with optimistic concurrency. Any eligible team member may call it for any of the team''s opportunities; a stale p_expected_version raises 40001 rather than overwriting a teammate. Spec sections 10, 14, 35.';

grant execute on function public.specialty_update_opportunity(uuid, jsonb, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. THE LINKED INTAKE EDIT  (spec section 20)
--
--    Customer, business and risk detail lives on cs_intake_submissions and is not
--    copied. A specialty member correcting a VIN therefore has to be able to write
--    to the intake — but can_edit_cs_intake only grants that for draft and returned
--    intakes, and a submitted specialty intake is 'converted'. This function is the
--    linked edit flow: team membership authorises it, the intake stays the single
--    source of truth, and both logs record it.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_update_intake(
  p_opportunity_id uuid,
  p_patch jsonb default '{}',
  p_drivers jsonb default null,
  p_vehicles jsonb default null,
  p_expected_intake_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
    'property_address_street', 'property_address_city', 'property_address_state',
    'property_address_zip', 'dwelling_type', 'year_built', 'square_footage',
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
            property_address_street, property_address_city, property_address_state,
            property_address_zip, dwelling_type, year_built, square_footage,
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
                   p.property_address_street, p.property_address_city, p.property_address_state,
                   p.property_address_zip, p.dwelling_type, p.year_built, p.square_footage,
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
$$;

comment on function public.specialty_update_intake(uuid, jsonb, jsonb, jsonb, integer) is
  'The linked intake edit. Lets an eligible specialty member correct customer, business, property, vehicle and driver information on the ORIGINAL intake rather than in a competing copy. Authorised by team membership; concurrency-checked against the intake''s own version; written to both the intake event log and the opportunity timeline. Spec section 20.';

grant execute on function public.specialty_update_intake(uuid, jsonb, jsonb, jsonb, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. STAGE
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_change_stage(
  p_opportunity_id uuid,
  p_stage text,
  p_expected_version integer default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.specialty_opportunities;
  v_stage public.specialty_workflow_stages;
  v_open_info integer;
begin
  v_row := public.specialty_lock_for_edit(p_opportunity_id, p_expected_version);

  if p_stage in ('sold', 'not_sold') then
    raise exception 'Use Record Result to mark a quote Sold or Not Sold, so the carrier, premium or reason is captured.';
  end if;

  if v_row.result is not null then
    raise exception 'This quote is closed. Clear the result before changing its stage.';
  end if;

  -- The template decides which stages exist, so a line of business can offer fewer.
  select * into v_stage
  from public.specialty_workflow_stages
  where template_id = v_row.workflow_template_id and stage_key = p_stage;
  if not found then
    raise exception 'Stage % is not part of this workflow.', p_stage;
  end if;

  if v_row.stage = p_stage then
    return jsonb_build_object('changed', false, 'stage', p_stage, 'version', v_row.version);
  end if;

  -- Follow-Up and Information Needed must name what happens next, so nothing can
  -- sit in them without accountability (spec sections 32, 35).
  if v_stage.requires_next_action
     and nullif(btrim(coalesce(v_row.next_action, '')), '') is null then
    raise exception 'Set a Next Action before moving this quote to %.', v_stage.label;
  end if;

  if p_stage = 'ready_to_market' then
    select count(*) into v_open_info
    from public.specialty_information_requests
    where opportunity_id = p_opportunity_id and status in ('needed', 'requested');
    if v_open_info > 0 then
      raise exception 'There are still % outstanding information item(s). Resolve or waive them before marking this Ready to Market.', v_open_info;
    end if;
  end if;

  perform set_config('specialty.privileged', 'on', true);

  update public.specialty_opportunities
     set stage = p_stage,
         ready_to_market_at = case
           when p_stage = 'ready_to_market' then coalesce(ready_to_market_at, now())
           else ready_to_market_at end,
         version = version + 1,
         last_activity_at = now()
   where id = p_opportunity_id;

  perform set_config('specialty.privileged', 'off', true);

  perform public.specialty_log(p_opportunity_id, 'stage_changed', jsonb_build_object(
    'from_stage', v_row.stage, 'to_stage', p_stage,
    'note', nullif(btrim(coalesce(p_note, '')), '')
  ));

  return jsonb_build_object('changed', true, 'stage', p_stage, 'version', v_row.version + 1);
end;
$$;

grant execute on function public.specialty_change_stage(uuid, text, integer, text) to authenticated;

-- Advances the stage as a consequence of real work, never backwards, and never out
-- of a closed or price-sent state. Called by the carrier-market and
-- information-request actions so an employee is not asked to keep the stage in
-- sync by hand.
create or replace function public.specialty_advance_stage(
  p_opportunity_id uuid,
  p_target text,
  p_from text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
  v_template uuid;
begin
  select stage, workflow_template_id into v_current, v_template
  from public.specialty_opportunities where id = p_opportunity_id;

  if v_current is null or not (v_current = any (p_from)) then return; end if;
  if not exists (select 1 from public.specialty_workflow_stages
                 where template_id = v_template and stage_key = p_target) then
    return;
  end if;

  perform set_config('specialty.privileged', 'on', true);
  update public.specialty_opportunities
     set stage = p_target,
         ready_to_market_at = case when p_target = 'ready_to_market'
                                   then coalesce(ready_to_market_at, now())
                                   else ready_to_market_at end
   where id = p_opportunity_id;
  perform set_config('specialty.privileged', 'off', true);

  perform public.specialty_log(p_opportunity_id, 'stage_changed', jsonb_build_object(
    'from_stage', v_current, 'to_stage', p_target, 'automatic', true));
end;
$$;

revoke all on function public.specialty_advance_stage(uuid, text, text[]) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. NOTES, CHECKLISTS, INFORMATION REQUESTS, DOCUMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_add_note(
  p_opportunity_id uuid,
  p_content text,
  p_carrier_market_id uuid default null,
  p_cs_visible boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.specialty_can_edit_opportunity(p_opportunity_id) then
    raise exception 'You cannot add notes to this specialty quote.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_content, '')), '') is null then
    raise exception 'A note cannot be empty.';
  end if;

  insert into public.specialty_notes
    (opportunity_id, carrier_market_id, author_id, content, is_cs_visible)
  values (p_opportunity_id, p_carrier_market_id, auth.uid(), btrim(p_content),
          coalesce(p_cs_visible, false))
  returning id into v_id;

  perform public.specialty_log(p_opportunity_id, 'note_added',
    jsonb_build_object('note_id', v_id, 'cs_visible', coalesce(p_cs_visible, false)),
    p_carrier_market_id);

  return v_id;
end;
$$;

grant execute on function public.specialty_add_note(uuid, text, uuid, boolean) to authenticated;

create or replace function public.specialty_add_checklist_item(
  p_opportunity_id uuid,
  p_category text,
  p_label text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_position integer;
begin
  if not public.specialty_can_edit_opportunity(p_opportunity_id) then
    raise exception 'You cannot change this checklist.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_label, '')), '') is null then
    raise exception 'A checklist item needs a label.';
  end if;

  select coalesce(max(position), 0) + 1 into v_position
  from public.specialty_checklist_items where opportunity_id = p_opportunity_id;

  insert into public.specialty_checklist_items
    (opportunity_id, category, label, position, is_custom, created_by)
  values (p_opportunity_id, coalesce(nullif(btrim(p_category), ''), 'Other'),
          btrim(p_label), v_position, true, auth.uid())
  returning id into v_id;

  perform public.specialty_log(p_opportunity_id, 'checklist_item_added',
    jsonb_build_object('item_id', v_id, 'label', btrim(p_label)));

  return v_id;
end;
$$;

grant execute on function public.specialty_add_checklist_item(uuid, text, text) to authenticated;

create or replace function public.specialty_toggle_checklist_item(
  p_item_id uuid,
  p_checked boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.specialty_checklist_items;
begin
  select * into v_item from public.specialty_checklist_items where id = p_item_id;
  if not found then raise exception 'That checklist item could not be found.'; end if;
  if not public.specialty_can_edit_opportunity(v_item.opportunity_id) then
    raise exception 'You cannot change this checklist.' using errcode = '42501';
  end if;

  update public.specialty_checklist_items
     set is_checked = coalesce(p_checked, false),
         checked_by = case when coalesce(p_checked, false) then auth.uid() else null end,
         checked_at = case when coalesce(p_checked, false) then now() else null end
   where id = p_item_id;

  perform public.specialty_log(v_item.opportunity_id, 'checklist_item_toggled',
    jsonb_build_object('item_id', p_item_id, 'label', v_item.label,
                       'is_checked', coalesce(p_checked, false)));
end;
$$;

grant execute on function public.specialty_toggle_checklist_item(uuid, boolean) to authenticated;

create or replace function public.specialty_add_information_request(
  p_opportunity_id uuid,
  p_label text,
  p_note text default null,
  p_visible_to_cs boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.specialty_can_edit_opportunity(p_opportunity_id) then
    raise exception 'You cannot change this quote''s information list.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_label, '')), '') is null then
    raise exception 'Name the information that is missing.';
  end if;

  insert into public.specialty_information_requests
    (opportunity_id, label, note, visible_to_cs, status, requested_at, requested_by, created_by)
  values (p_opportunity_id, btrim(p_label), nullif(btrim(coalesce(p_note, '')), ''),
          coalesce(p_visible_to_cs, true), 'requested', now(), auth.uid(), auth.uid())
  returning id into v_id;

  perform public.specialty_log(p_opportunity_id, 'information_requested',
    jsonb_build_object('request_id', v_id, 'label', btrim(p_label),
                       'visible_to_cs', coalesce(p_visible_to_cs, true)));

  -- Outstanding information is what Information Needed means, so the stage follows
  -- the fact rather than waiting for someone to remember.
  perform public.specialty_advance_stage(p_opportunity_id, 'information_needed',
    array['new', 'ready_to_market']);

  return v_id;
end;
$$;

grant execute on function public.specialty_add_information_request(uuid, text, text, boolean) to authenticated;

create or replace function public.specialty_resolve_information_request(
  p_request_id uuid,
  p_status text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.specialty_information_requests;
  v_open integer;
begin
  select * into v_req from public.specialty_information_requests where id = p_request_id;
  if not found then raise exception 'That information item could not be found.'; end if;
  if not public.specialty_can_edit_opportunity(v_req.opportunity_id) then
    raise exception 'You cannot change this quote''s information list.' using errcode = '42501';
  end if;
  if p_status not in ('needed', 'requested', 'received', 'waived') then
    raise exception 'Unknown information status %.', p_status;
  end if;

  update public.specialty_information_requests
     set status = p_status,
         note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note),
         resolved_at = case when p_status in ('received', 'waived') then now() else null end,
         resolved_by = case when p_status in ('received', 'waived') then auth.uid() else null end
   where id = p_request_id;

  perform public.specialty_log(v_req.opportunity_id,
    case p_status when 'received' then 'information_received'
                  when 'waived' then 'information_waived'
                  else 'information_requested' end,
    jsonb_build_object('request_id', p_request_id, 'label', v_req.label,
                       'from_status', v_req.status, 'to_status', p_status,
                       'note', nullif(btrim(coalesce(p_note, '')), '')));

  select count(*) into v_open
  from public.specialty_information_requests
  where opportunity_id = v_req.opportunity_id and status in ('needed', 'requested');

  if v_open = 0 then
    perform public.specialty_advance_stage(v_req.opportunity_id, 'ready_to_market',
      array['information_needed']);
  end if;
end;
$$;

grant execute on function public.specialty_resolve_information_request(uuid, text, text) to authenticated;

create or replace function public.specialty_register_document(
  p_opportunity_id uuid,
  p_file_name text,
  p_file_size bigint,
  p_mime_type text,
  p_storage_path text,
  p_category text default 'other',
  p_carrier_market_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.specialty_can_edit_opportunity(p_opportunity_id) then
    raise exception 'You cannot add documents to this specialty quote.' using errcode = '42501';
  end if;

  -- The object must sit under this opportunity's own prefix, so a metadata row can
  -- never point at another team's file.
  if split_part(coalesce(p_storage_path, ''), '/', 1) <> p_opportunity_id::text then
    raise exception 'A document must be stored under its own quote.';
  end if;

  insert into public.specialty_documents
    (opportunity_id, carrier_market_id, uploaded_by, file_name, file_size,
     mime_type, storage_bucket, storage_path, category)
  values (p_opportunity_id, p_carrier_market_id, auth.uid(), p_file_name, p_file_size,
          coalesce(nullif(p_mime_type, ''), 'application/octet-stream'),
          'specialty-quote-documents', p_storage_path,
          coalesce(nullif(p_category, ''), 'other'))
  returning id into v_id;

  perform public.specialty_log(p_opportunity_id, 'document_uploaded',
    jsonb_build_object('document_id', v_id, 'file_name', p_file_name,
                       'category', coalesce(nullif(p_category, ''), 'other')),
    p_carrier_market_id);

  return v_id;
end;
$$;

grant execute on function public.specialty_register_document(uuid, text, bigint, text, text, text, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. CARRIER MARKETS  (spec sections 39-44)
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_add_carrier_market(
  p_opportunity_id uuid,
  p_carrier_id uuid,
  p_status text default 'not_started',
  p_handled_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_carrier text;
begin
  if not public.specialty_can_edit_opportunity(p_opportunity_id) then
    raise exception 'You cannot add carriers to this specialty quote.' using errcode = '42501';
  end if;

  select name into v_carrier from public.specialty_carriers where id = p_carrier_id and is_active;
  if v_carrier is null then raise exception 'That carrier could not be found.'; end if;

  if exists (select 1 from public.specialty_carrier_markets
             where opportunity_id = p_opportunity_id and carrier_id = p_carrier_id) then
    raise exception '% is already being marketed on this quote.', v_carrier;
  end if;

  insert into public.specialty_carrier_markets
    (opportunity_id, carrier_id, status, handled_by, created_by, last_action_by, last_action_at)
  values (p_opportunity_id, p_carrier_id,
          coalesce(nullif(p_status, ''), 'not_started'), p_handled_by, auth.uid(), auth.uid(), now())
  returning id into v_id;

  perform public.specialty_log(p_opportunity_id, 'carrier_added',
    jsonb_build_object('carrier_id', p_carrier_id, 'carrier_name', v_carrier,
                       'status', coalesce(nullif(p_status, ''), 'not_started')),
    v_id);

  return v_id;
end;
$$;

grant execute on function public.specialty_add_carrier_market(uuid, uuid, text, uuid) to authenticated;

create or replace function public.specialty_update_carrier_market(
  p_market_id uuid,
  p_patch jsonb,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market public.specialty_carrier_markets;
  v_carrier text;
  v_key text;
  v_status text;
  v_allowed text[] := array[
    'status', 'handled_by', 'follow_up_date', 'premium', 'down_payment',
    'payment_terms', 'deductible', 'coverage_notes', 'decline_reason',
    'info_requested', 'notes', 'submitted_at'
  ];
begin
  select * into v_market from public.specialty_carrier_markets where id = p_market_id for update;
  if not found then raise exception 'That carrier market could not be found.'; end if;

  if not public.specialty_can_edit_opportunity(v_market.opportunity_id) then
    raise exception 'You cannot change carriers on this specialty quote.' using errcode = '42501';
  end if;

  if p_expected_version is not null and v_market.version <> p_expected_version then
    raise exception 'This carrier was updated by another employee while you were working on it. Review the latest information before saving.'
      using errcode = '40001';
  end if;

  for v_key in select jsonb_object_keys(p_patch) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'Field % cannot be changed on a carrier market.', v_key;
    end if;
  end loop;

  select name into v_carrier from public.specialty_carriers where id = v_market.carrier_id;
  v_status := coalesce(nullif(p_patch ->> 'status', ''), v_market.status);

  if v_status not in ('not_started', 'preparing', 'submitted', 'waiting', 'more_info_needed',
                      'quote_received', 'declined', 'not_competitive', 'withdrawn') then
    raise exception 'Unknown carrier status %.', v_status;
  end if;

  -- Validation before the write, so the message names the missing thing rather than
  -- surfacing a constraint violation.
  if v_status = 'quote_received'
     and coalesce(nullif(p_patch ->> 'premium', '')::numeric, v_market.premium) is null then
    raise exception 'Enter the quoted premium when a carrier quote is received.';
  end if;
  if v_status = 'declined'
     and nullif(btrim(coalesce(p_patch ->> 'decline_reason', v_market.decline_reason, '')), '') is null then
    raise exception 'Record why % declined.', coalesce(v_carrier, 'the carrier');
  end if;
  if v_status = 'more_info_needed'
     and nullif(btrim(coalesce(p_patch ->> 'info_requested', v_market.info_requested, '')), '') is null then
    raise exception 'Record what % is asking for.', coalesce(v_carrier, 'the carrier');
  end if;

  update public.specialty_carrier_markets m
     set status = v_status,
         handled_by = case when p_patch ? 'handled_by'
                           then nullif(p_patch ->> 'handled_by', '')::uuid else m.handled_by end,
         follow_up_date = case when p_patch ? 'follow_up_date'
                               then nullif(p_patch ->> 'follow_up_date', '')::date else m.follow_up_date end,
         premium = case when p_patch ? 'premium'
                        then nullif(p_patch ->> 'premium', '')::numeric else m.premium end,
         down_payment = case when p_patch ? 'down_payment'
                             then nullif(p_patch ->> 'down_payment', '')::numeric else m.down_payment end,
         payment_terms = case when p_patch ? 'payment_terms'
                              then nullif(btrim(p_patch ->> 'payment_terms'), '') else m.payment_terms end,
         deductible = case when p_patch ? 'deductible'
                           then nullif(btrim(p_patch ->> 'deductible'), '') else m.deductible end,
         coverage_notes = case when p_patch ? 'coverage_notes'
                               then nullif(btrim(p_patch ->> 'coverage_notes'), '') else m.coverage_notes end,
         decline_reason = case when p_patch ? 'decline_reason'
                               then nullif(btrim(p_patch ->> 'decline_reason'), '') else m.decline_reason end,
         info_requested = case when p_patch ? 'info_requested'
                               then nullif(btrim(p_patch ->> 'info_requested'), '') else m.info_requested end,
         notes = case when p_patch ? 'notes'
                      then nullif(btrim(p_patch ->> 'notes'), '') else m.notes end,
         -- Submission and quote receipt are stamped the first time the status says
         -- so, and the employee who did it is recorded. Later edits do not move the
         -- date, because the pipeline timings depend on when it actually happened.
         submitted_at = case
           when p_patch ? 'submitted_at' then nullif(p_patch ->> 'submitted_at', '')::timestamptz
           when v_status in ('submitted', 'waiting', 'more_info_needed', 'quote_received',
                             'declined', 'not_competitive')
             then coalesce(m.submitted_at, now())
           else m.submitted_at end,
         submitted_by = case
           when m.submitted_by is null
                and v_status in ('submitted', 'waiting', 'more_info_needed', 'quote_received',
                                 'declined', 'not_competitive')
             then auth.uid()
           else m.submitted_by end,
         quote_received_at = case
           when v_status = 'quote_received' then coalesce(m.quote_received_at, now())
           else m.quote_received_at end,
         quote_received_by = case
           when v_status = 'quote_received' and m.quote_received_by is null then auth.uid()
           else m.quote_received_by end,
         last_action_at = now(),
         last_action_by = auth.uid(),
         version = m.version + 1
   where m.id = p_market_id;

  perform public.specialty_log(v_market.opportunity_id,
    case v_status
      when 'submitted' then 'carrier_submitted'
      when 'quote_received' then 'carrier_quote_received'
      when 'declined' then 'carrier_declined'
      when 'withdrawn' then 'carrier_withdrawn'
      else 'carrier_updated' end,
    jsonb_build_object(
      'carrier_id', v_market.carrier_id,
      'carrier_name', v_carrier,
      'from_status', v_market.status,
      'to_status', v_status,
      'premium', case when p_patch ? 'premium' then nullif(p_patch ->> 'premium', '') else null end,
      'patch_fields', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p_patch) k)
    ),
    p_market_id);

  -- The opportunity's stage follows what the markets are actually doing.
  if v_market.submitted_at is null and v_status in ('submitted', 'waiting', 'more_info_needed',
                                                    'quote_received', 'declined', 'not_competitive') then
    perform set_config('specialty.privileged', 'on', true);
    update public.specialty_opportunities
       set first_submission_at = coalesce(first_submission_at, now())
     where id = v_market.opportunity_id;
    perform set_config('specialty.privileged', 'off', true);
    perform public.specialty_advance_stage(v_market.opportunity_id, 'marketing',
      array['new', 'information_needed', 'ready_to_market']);
  end if;

  if v_status = 'quote_received' then
    perform set_config('specialty.privileged', 'on', true);
    update public.specialty_opportunities
       set first_quote_at = coalesce(first_quote_at, now())
     where id = v_market.opportunity_id;
    perform set_config('specialty.privileged', 'off', true);
    perform public.specialty_advance_stage(v_market.opportunity_id, 'options_ready',
      array['new', 'information_needed', 'ready_to_market', 'marketing']);
  end if;

  update public.specialty_opportunities
     set last_activity_at = now() where id = v_market.opportunity_id;

  return jsonb_build_object('version', v_market.version + 1, 'status', v_status);
end;
$$;

comment on function public.specialty_update_carrier_market(uuid, jsonb, integer) is
  'Updates one carrier market. Any eligible team member may update any market on the team''s opportunity — Oscar records the Progressive premium Jason submitted — and the activity row names whoever actually acted. Advances the opportunity stage as a consequence of real marketing progress. Spec sections 40-44.';

grant execute on function public.specialty_update_carrier_market(uuid, jsonb, integer) to authenticated;

create or replace function public.specialty_remove_carrier_market(p_market_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market public.specialty_carrier_markets;
  v_carrier text;
begin
  select * into v_market from public.specialty_carrier_markets where id = p_market_id;
  if not found then raise exception 'That carrier market could not be found.'; end if;
  if not public.specialty_can_edit_opportunity(v_market.opportunity_id) then
    raise exception 'You cannot change carriers on this specialty quote.' using errcode = '42501';
  end if;
  if v_market.submitted_at is not null then
    raise exception 'This carrier was already submitted. Set it to Withdrawn instead so the marketing history is kept.';
  end if;

  select name into v_carrier from public.specialty_carriers where id = v_market.carrier_id;

  delete from public.specialty_carrier_markets where id = p_market_id;

  perform public.specialty_log(v_market.opportunity_id, 'carrier_removed',
    jsonb_build_object('carrier_id', v_market.carrier_id, 'carrier_name', v_carrier));
end;
$$;

grant execute on function public.specialty_remove_carrier_market(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. CUSTOMER PRICING  (spec sections 31, 46)
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_record_price_sent(
  p_opportunity_id uuid,
  p_market_ids uuid[],
  p_method text default null,
  p_note text default null,
  p_expected_version integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.specialty_opportunities;
  v_options jsonb;
  v_count integer;
  v_id uuid;
begin
  v_row := public.specialty_lock_for_edit(p_opportunity_id, p_expected_version);

  if p_market_ids is null or array_length(p_market_ids, 1) is null then
    raise exception 'Choose at least one option to record as sent to the customer.';
  end if;

  -- A frozen snapshot of what the customer was actually shown. Recomputing this
  -- later from the carrier markets would rewrite history the moment a premium is
  -- corrected.
  select coalesce(jsonb_agg(jsonb_build_object(
           'carrier_market_id', m.id,
           'carrier_id', m.carrier_id,
           'carrier_name', c.name,
           'premium', m.premium,
           'down_payment', m.down_payment,
           'payment_terms', m.payment_terms,
           'deductible', m.deductible
         ) order by m.premium nulls last), '[]'::jsonb),
         count(*)
    into v_options, v_count
  from public.specialty_carrier_markets m
  join public.specialty_carriers c on c.id = m.carrier_id
  where m.id = any (p_market_ids)
    and m.opportunity_id = p_opportunity_id;

  if v_count <> array_length(p_market_ids, 1) then
    raise exception 'One of those options does not belong to this quote.';
  end if;

  if exists (select 1 from public.specialty_carrier_markets
             where id = any (p_market_ids) and premium is null) then
    raise exception 'Every option sent to the customer needs a premium.';
  end if;

  insert into public.specialty_price_presentations
    (opportunity_id, presented_by, method, note, options)
  values (p_opportunity_id, auth.uid(),
          nullif(p_method, ''), nullif(btrim(coalesce(p_note, '')), ''), v_options)
  returning id into v_id;

  update public.specialty_carrier_markets
     set presented_at = coalesce(presented_at, now())
   where id = any (p_market_ids);

  perform set_config('specialty.privileged', 'on', true);
  update public.specialty_opportunities
     set stage = case when stage in ('sold', 'not_sold') then stage else 'price_sent' end,
         price_sent_at = coalesce(price_sent_at, now()),
         version = version + 1,
         last_activity_at = now()
   where id = p_opportunity_id;
  perform set_config('specialty.privileged', 'off', true);

  perform public.specialty_log(p_opportunity_id, 'price_sent', jsonb_build_object(
    'presentation_id', v_id,
    'method', nullif(p_method, ''),
    'option_count', v_count,
    'options', v_options,
    'note', nullif(btrim(coalesce(p_note, '')), '')
  ));

  if v_row.stage not in ('price_sent', 'sold', 'not_sold') then
    perform public.specialty_log(p_opportunity_id, 'stage_changed', jsonb_build_object(
      'from_stage', v_row.stage, 'to_stage', 'price_sent', 'automatic', true));
  end if;

  return v_id;
end;
$$;

comment on function public.specialty_record_price_sent(uuid, uuid[], text, text, integer) is
  'Records that specific options actually went to the customer. Receiving a carrier quote is not the same event and does not set this. Stores a frozen snapshot of the carriers and amounts presented, the employee who sent them and when. Spec sections 31, 46.';

grant execute on function public.specialty_record_price_sent(uuid, uuid[], text, text, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. OUTCOME  (spec sections 33, 34)
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_record_result(
  p_opportunity_id uuid,
  p_result text,
  p_bound_market_id uuid default null,
  p_sold_premium numeric default null,
  p_lost_reason text default null,
  p_lost_reason_note text default null,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.specialty_opportunities;
  v_carrier_id uuid;
  v_carrier text;
  v_premium numeric;
begin
  v_row := public.specialty_lock_for_edit(p_opportunity_id, p_expected_version);

  if p_result not in ('sold', 'not_sold') then
    raise exception 'A result must be Sold or Not Sold.';
  end if;

  if p_result = 'sold' then
    if p_bound_market_id is null then
      raise exception 'Record which carrier the policy was bound with.';
    end if;
    select m.carrier_id, c.name, coalesce(p_sold_premium, m.premium)
      into v_carrier_id, v_carrier, v_premium
    from public.specialty_carrier_markets m
    join public.specialty_carriers c on c.id = m.carrier_id
    where m.id = p_bound_market_id and m.opportunity_id = p_opportunity_id;

    if v_carrier_id is null then
      raise exception 'That carrier is not one of this quote''s markets.';
    end if;
    if v_premium is null then
      raise exception 'Record the sold premium.';
    end if;
  else
    -- A blank Not Sold reason is never accepted (spec section 34).
    if nullif(btrim(coalesce(p_lost_reason, '')), '') is null then
      raise exception 'Choose a reason this quote was not sold.';
    end if;
    if p_lost_reason not in ('price_too_high', 'stayed_with_current_carrier',
        'customer_stopped_responding', 'competitor', 'ineligible',
        'unable_to_place', 'customer_postponed', 'duplicate', 'other') then
      raise exception 'Unknown Not Sold reason %.', p_lost_reason;
    end if;
  end if;

  perform set_config('specialty.privileged', 'on', true);

  update public.specialty_opportunities
     set stage = p_result,
         result = p_result,
         bound_carrier_id = case when p_result = 'sold' then v_carrier_id else null end,
         sold_premium = case when p_result = 'sold' then v_premium else null end,
         lost_reason = case when p_result = 'not_sold' then p_lost_reason else null end,
         lost_reason_note = case when p_result = 'not_sold'
                                 then nullif(btrim(coalesce(p_lost_reason_note, '')), '')
                                 else null end,
         result_recorded_by = auth.uid(),
         finalized_at = now(),
         version = version + 1,
         last_activity_at = now()
   where id = p_opportunity_id;

  perform set_config('specialty.privileged', 'off', true);

  perform public.specialty_log(p_opportunity_id, 'result_recorded', jsonb_build_object(
    'result', p_result,
    'from_stage', v_row.stage,
    'bound_carrier_id', v_carrier_id,
    'bound_carrier_name', v_carrier,
    'sold_premium', v_premium,
    'lost_reason', case when p_result = 'not_sold' then p_lost_reason else null end,
    'lost_reason_note', nullif(btrim(coalesce(p_lost_reason_note, '')), ''),
    -- The primary assignee is recorded alongside the actor, because reporting needs
    -- both and must never infer one from the other.
    'primary_assignee_id', v_row.primary_assignee_id
  ), p_bound_market_id);

  return jsonb_build_object('result', p_result, 'version', v_row.version + 1);
end;
$$;

grant execute on function public.specialty_record_result(uuid, text, uuid, numeric, text, text, integer) to authenticated;

-- Reopening is a management act: the outcome has already been reported on.
create or replace function public.specialty_clear_result(
  p_opportunity_id uuid,
  p_stage text default 'follow_up',
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.specialty_opportunities;
begin
  if not public.specialty_is_manager() then
    raise exception 'Only a manager can reopen a closed specialty quote.' using errcode = '42501';
  end if;
  if p_stage in ('sold', 'not_sold') then
    raise exception 'Reopen to an active stage.';
  end if;

  select * into v_row from public.specialty_opportunities where id = p_opportunity_id for update;
  if not found then raise exception 'That specialty quote could not be found.'; end if;
  if v_row.result is null then
    return jsonb_build_object('changed', false, 'version', v_row.version);
  end if;

  perform set_config('specialty.privileged', 'on', true);
  update public.specialty_opportunities
     set stage = p_stage, result = null, lost_reason = null, lost_reason_note = null,
         bound_carrier_id = null, sold_premium = null, finalized_at = null,
         result_recorded_by = null, version = version + 1, last_activity_at = now()
   where id = p_opportunity_id;
  perform set_config('specialty.privileged', 'off', true);

  perform public.specialty_log(p_opportunity_id, 'result_cleared', jsonb_build_object(
    'previous_result', v_row.result, 'to_stage', p_stage,
    'reason', nullif(btrim(coalesce(p_reason, '')), '')));

  return jsonb_build_object('changed', true, 'version', v_row.version + 1);
end;
$$;

grant execute on function public.specialty_clear_result(uuid, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. TEAM ADMINISTRATION  (spec sections 5, 67-70, 87)
--
--     Configuration-driven: a manager creating a new team with new members and a
--     new line-of-business route needs no developer change to authorization logic,
--     because every predicate in v1.16.0 and v1.16.1 reads these tables.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_team_save(
  p_team_id uuid,
  p_name text,
  p_description text default null,
  p_assignment_method text default 'shared_claim',
  p_collaborative_editing boolean default true,
  p_team_visibility text default 'team',
  p_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := p_team_id;
  v_before public.quoting_teams;
  v_blocking text;
begin
  if not public.specialty_is_manager() then
    raise exception 'Only a manager can configure quoting teams.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'A team needs a name.';
  end if;

  if v_id is null then
    insert into public.quoting_teams
      (name, description, assignment_method, collaborative_editing, team_visibility,
       is_active, created_by)
    values (btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''),
            coalesce(p_assignment_method, 'shared_claim'),
            coalesce(p_collaborative_editing, true),
            coalesce(p_team_visibility, 'team'),
            coalesce(p_is_active, true), auth.uid())
    returning id into v_id;

    insert into public.quoting_team_events (team_id, actor_profile_id, event_type, details)
    values (v_id, auth.uid(), 'team_created', jsonb_build_object('name', btrim(p_name)));
    return v_id;
  end if;

  select * into v_before from public.quoting_teams where id = v_id for update;
  if not found then raise exception 'That quoting team could not be found.'; end if;

  -- A line of business must always have somewhere to go. Deactivating the only
  -- active destination for a routed line is refused with the reason (spec 69).
  if v_before.is_active and not coalesce(p_is_active, true) then
    select string_agg(distinct r.line_of_business, ', ') into v_blocking
    from public.quoting_team_lob_routes r
    where r.team_id = v_id
      and r.is_active
      and not exists (
        select 1 from public.quoting_team_lob_routes alt
        join public.quoting_teams t2 on t2.id = alt.team_id
        where alt.line_of_business = r.line_of_business
          and alt.is_active and alt.team_id <> v_id and t2.is_active
      );
    if v_blocking is not null then
      raise exception 'This team is the only active destination for: %. Configure another team for those lines before deactivating it.', v_blocking;
    end if;
  end if;

  update public.quoting_teams
     set name = btrim(p_name),
         description = nullif(btrim(coalesce(p_description, '')), ''),
         assignment_method = coalesce(p_assignment_method, assignment_method),
         collaborative_editing = coalesce(p_collaborative_editing, collaborative_editing),
         team_visibility = coalesce(p_team_visibility, team_visibility),
         is_active = coalesce(p_is_active, is_active)
   where id = v_id;

  insert into public.quoting_team_events (team_id, actor_profile_id, event_type, details)
  values (v_id, auth.uid(),
          case when v_before.is_active and not coalesce(p_is_active, true) then 'team_deactivated'
               when not v_before.is_active and coalesce(p_is_active, true) then 'team_activated'
               else 'team_updated' end,
          jsonb_build_object(
            'name', btrim(p_name),
            'previous_name', v_before.name,
            'assignment_method', coalesce(p_assignment_method, v_before.assignment_method),
            'collaborative_editing', coalesce(p_collaborative_editing, v_before.collaborative_editing),
            'is_active', coalesce(p_is_active, v_before.is_active)));

  return v_id;
end;
$$;

grant execute on function public.specialty_team_save(uuid, text, text, text, boolean, text, boolean) to authenticated;

create or replace function public.specialty_team_save_member(
  p_team_id uuid,
  p_profile_id uuid,
  p_can_view boolean default true,
  p_can_claim boolean default true,
  p_can_edit boolean default true,
  p_can_be_assigned boolean default true,
  p_can_reassign boolean default true,
  p_can_view_reports boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_existed boolean;
begin
  if not public.specialty_is_manager() then
    raise exception 'Only a manager can change team membership.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles where id = p_profile_id and is_active) then
    raise exception 'That employee is not an active user.';
  end if;

  select true into v_existed from public.quoting_team_members
   where team_id = p_team_id and profile_id = p_profile_id and is_active;

  insert into public.quoting_team_members
    (team_id, profile_id, can_view, can_claim, can_edit, can_be_assigned,
     can_reassign, can_view_reports, is_active, added_by)
  values (p_team_id, p_profile_id, coalesce(p_can_view, true), coalesce(p_can_claim, true),
          coalesce(p_can_edit, true), coalesce(p_can_be_assigned, true),
          coalesce(p_can_reassign, true), coalesce(p_can_view_reports, true), true, auth.uid())
  on conflict (team_id, profile_id) do update
    set can_view = coalesce(p_can_view, true),
        can_claim = coalesce(p_can_claim, true),
        can_edit = coalesce(p_can_edit, true),
        can_be_assigned = coalesce(p_can_be_assigned, true),
        can_reassign = coalesce(p_can_reassign, true),
        can_view_reports = coalesce(p_can_view_reports, true),
        is_active = true,
        removed_at = null, removed_by = null, removed_reason = null
  returning id into v_id;

  insert into public.quoting_team_events (team_id, actor_profile_id, event_type, details)
  values (p_team_id, auth.uid(),
          case when coalesce(v_existed, false) then 'member_updated' else 'member_added' end,
          jsonb_build_object('profile_id', p_profile_id));

  return v_id;
end;
$$;

grant execute on function public.specialty_team_save_member(uuid, uuid, boolean, boolean, boolean, boolean, boolean, boolean) to authenticated;

-- Removing a member never deletes or orphans their work. Their open assignments are
-- reported back so the manager resolves them, and the membership row survives so
-- historical attribution keeps working (spec section 68).
create or replace function public.specialty_team_remove_member(
  p_team_id uuid,
  p_profile_id uuid,
  p_reason text default null,
  p_reassign_to uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open integer;
  v_moved integer := 0;
  v_id uuid;
begin
  if not public.specialty_is_manager() then
    raise exception 'Only a manager can change team membership.' using errcode = '42501';
  end if;

  select count(*) into v_open
  from public.specialty_opportunities
  where team_id = p_team_id
    and primary_assignee_id = p_profile_id
    and stage not in ('sold', 'not_sold');

  if v_open > 0 then
    if p_reassign_to is null then
      -- Refuse rather than silently strand the work. The caller is told exactly how
      -- much there is so a manager can decide where it goes.
      raise exception 'This employee still has % active assignment(s) on this team. Choose who they transfer to, then remove the member.', v_open;
    end if;

    if not exists (
      select 1 from public.quoting_team_members m join public.profiles p on p.id = m.profile_id
      where m.team_id = p_team_id and m.profile_id = p_reassign_to
        and m.is_active and m.can_be_assigned and p.is_active
    ) then
      raise exception 'That employee cannot be assigned work on this team.';
    end if;

    for v_id in
      select id from public.specialty_opportunities
      where team_id = p_team_id and primary_assignee_id = p_profile_id
        and stage not in ('sold', 'not_sold')
    loop
      perform public.specialty_reassign_opportunity(v_id, p_reassign_to,
        coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Team membership removed'));
      v_moved := v_moved + 1;
    end loop;
  end if;

  -- Retired, not deleted.
  update public.quoting_team_members
     set is_active = false, can_claim = false, can_be_assigned = false,
         removed_at = now(), removed_by = auth.uid(),
         removed_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where team_id = p_team_id and profile_id = p_profile_id;

  insert into public.quoting_team_events (team_id, actor_profile_id, event_type, details)
  values (p_team_id, auth.uid(), 'member_removed', jsonb_build_object(
    'profile_id', p_profile_id, 'reassigned_count', v_moved,
    'reassigned_to', p_reassign_to,
    'reason', nullif(btrim(coalesce(p_reason, '')), '')));

  return jsonb_build_object('removed', true, 'reassigned_count', v_moved);
end;
$$;

grant execute on function public.specialty_team_remove_member(uuid, uuid, text, uuid) to authenticated;

create or replace function public.specialty_team_set_route(
  p_line_of_business text,
  p_team_id uuid,
  p_workflow_template_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_template uuid := p_workflow_template_id;
  v_id uuid;
begin
  if not public.specialty_is_manager() then
    raise exception 'Only a manager can change line-of-business routing.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.quoting_teams where id = p_team_id and is_active) then
    raise exception 'That quoting team is not active.';
  end if;

  if v_template is null then
    select id into v_template from public.specialty_workflow_templates
     where line_of_business = p_line_of_business and is_active
     order by created_at limit 1;
  end if;
  if v_template is null then
    raise exception 'There is no active workflow template for %.', p_line_of_business;
  end if;

  -- One active default per line, so the routing question always has one answer.
  update public.quoting_team_lob_routes
     set is_active = false
   where line_of_business = p_line_of_business and is_active;

  insert into public.quoting_team_lob_routes
    (line_of_business, team_id, workflow_template_id, is_default, is_active, created_by)
  values (p_line_of_business, p_team_id, v_template, true, true, auth.uid())
  returning id into v_id;

  insert into public.quoting_team_events (team_id, actor_profile_id, event_type, details)
  values (p_team_id, auth.uid(), 'route_created', jsonb_build_object(
    'line_of_business', p_line_of_business, 'workflow_template_id', v_template));

  return v_id;
end;
$$;

grant execute on function public.specialty_team_set_route(text, uuid, uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. POST-CONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════════

do $post$
declare
  v_missing text;
begin
  select string_agg(f.name, ', ' order by f.name) into v_missing
    from (values
      ('specialty_log'), ('specialty_lock_for_edit'), ('specialty_claim_opportunity'),
      ('specialty_reassign_opportunity'), ('specialty_update_opportunity'),
      ('specialty_update_intake'), ('specialty_change_stage'), ('specialty_advance_stage'),
      ('specialty_add_note'), ('specialty_add_checklist_item'),
      ('specialty_toggle_checklist_item'), ('specialty_add_information_request'),
      ('specialty_resolve_information_request'), ('specialty_register_document'),
      ('specialty_add_carrier_market'), ('specialty_update_carrier_market'),
      ('specialty_remove_carrier_market'), ('specialty_record_price_sent'),
      ('specialty_record_result'), ('specialty_clear_result'),
      ('specialty_team_save'), ('specialty_team_save_member'),
      ('specialty_team_remove_member'), ('specialty_team_set_route')
    ) as f(name)
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = f.name and p.prosecdef);
  if v_missing is not null then
    raise exception 'v1.16.2 missing security definer function(s): %', v_missing using hint = 'Rolling back.';
  end if;

  -- The internal helpers must NOT be callable from a client, or history could be
  -- forged and the column guard bypassed.
  if has_function_privilege('authenticated', 'public.specialty_log(uuid, text, jsonb, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.specialty_advance_stage(uuid, text, text[])', 'execute')
     or has_function_privilege('authenticated', 'public.specialty_lock_for_edit(uuid, integer)', 'execute') then
    raise exception 'v1.16.2 left an internal specialty helper executable by authenticated'
      using hint = 'Rolling back.';
  end if;

  -- Nothing in this migration may touch a rotation.
  select string_agg(p.proname, ', ') into v_missing
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'specialty\_%'
     and (pg_get_functiondef(p.oid) like '%rotation_state%'
          or pg_get_functiondef(p.oid) like '%turn_events%');
  if v_missing is not null then
    raise exception 'v1.16.2 gave a specialty function a rotation side effect: %', v_missing
      using hint = 'Rolling back.';
  end if;
end
$post$;

commit;

select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'specialty\_%') as specialty_functions,
  (select count(*) from public.specialty_opportunities) as opportunities_expect_0;
