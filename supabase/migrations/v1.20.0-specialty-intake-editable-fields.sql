-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.20.0 — Let the specialty team correct the fields the workspace shows
--
-- WHY THIS MIGRATION EXISTS
--
-- The Specialty Quote workspace puts requested coverage and structured cargo on the
-- screen and offers to edit them where they live. `specialty_update_intake` — the one
-- path by which a specialty member may correct the linked Customer Service intake —
-- could not accept any of those columns. Its allow-list stopped at the fields that
-- existed in v1.16.2 plus the six homeowners columns added in v1.19.5, so every
-- coverage limit (v1.19.2), every cargo classification column (v1.18.0, v1.18.2) and
-- every underwriting answer (v1.19.2) was refused with "Field X cannot be changed
-- from Specialty Quotes."
--
-- The live definition was dumped and compared before writing this, per the repository
-- rule about repo/live drift: live matched v1.19.5 exactly, so this is a clean
-- forward step and not a patch over an unknown body.
--
-- TWO DEFECTS ARE FIXED, NOT ONE
--
-- 1. The allow-list is widened to the risk and coverage detail the workspace shows.
--    Deliberately still an allow-list: `status`, `version`, `submission_id`,
--    `created_by`, the conversion columns and anything else that decides where an
--    intake is in its own lifecycle stay refused, and the probe below proves it.
--
-- 2. The patch is applied dynamically instead of through a hand-written column tuple.
--    The old body listed all fifty allowed columns twice — once in the SET tuple and
--    once in the SELECT — which is why widening the list previously meant editing
--    three places and is why the list had fallen behind the schema. Now the allow-list
--    is the single source of truth, and a column added to it cannot be forgotten in
--    the UPDATE. The keys are validated against a literal array before they ever reach
--    `format('%I')`, so this is not an injection surface.
--
-- 3. The vehicles and drivers replace-all now carries the trucking columns.
--    This one is a latent data-loss bug, not an omission. Both branches DELETE every
--    row and re-INSERT from the supplied array, and the INSERT column lists predate
--    v1.18.1/v1.18.3/v1.19.2. Any caller that passed `p_drivers` or `p_vehicles` would
--    have silently erased `truck_type`, `physical_damage_value`,
--    `physical_damage_deductible`, `coverage_type`, `lessor_name`, `lessor_address`,
--    `cdl`, `cdl_date`, `cdl_years_experience`, `owner_operator` and both incident
--    pairs. Nothing has called it that way yet — the retired drawer only ever sent
--    `p_patch` — and the workspace's driver and unit editors are about to, so the
--    columns are added here rather than discovered in production.
--
--    Two details in that INSERT are load-bearing and easy to get wrong:
--
--    * The nullable answers — cdl, owner_operator, accidents_36mo, violations_36mo —
--      are carried as NULL when NULL. Defaulting them to false would turn "nobody has
--      asked yet" into "the insured says no", and an application that answers an
--      underwriting question nobody asked is worse than one that leaves it blank. The
--      blank is what the readiness check and the workspace's gap list look for.
--      sr22_required and vin_pending are NOT NULL on their tables, so those two do
--      default, and the editors offer them as plain Yes/No rather than three-way.
--
--    * The jsonb columns use `nullif(r -> 'k', 'null'::jsonb)` and not `coalesce`
--      alone. These payloads come back from `to_jsonb(row)`, so a NULL column arrives
--      as a jsonb null rather than as SQL NULL, and coalesce does not fire on it — the
--      string "null" would land in a not-null jsonb column and break every later read.
--
-- NOT CHANGED: the signature, the authorization check, the intake-version concurrency
-- refusal, the SECURITY DEFINER marking, the search_path, the dual audit write, or the
-- return shape. `create or replace` preserves the existing grant to `authenticated`.
--
-- Forward-only. No historical migration is edited and no data is migrated.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. PRE-CONDITIONS
--
--    Every column this migration promises to accept must already exist. Widening an
--    allow-list to name a column that is not there would turn a clear refusal into a
--    runtime error inside a security definer function.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_missing text;
begin
  select string_agg(format('%s.%s', t.tbl, t.col), ', ' order by t.tbl, t.col)
    into v_missing
  from (values
    ('cs_intake_submissions', 'ein'),
    ('cs_intake_submissions', 'auto_liability_limit'),
    ('cs_intake_submissions', 'requested_cargo_limit'),
    ('cs_intake_submissions', 'primary_commodity'),
    ('cs_intake_submissions', 'excluded_cargo'),
    ('cs_intake_submissions', 'operation_types'),
    ('cs_intake_submissions', 'uw_losses_3yr'),
    ('cs_intake_vehicles', 'truck_type'),
    ('cs_intake_vehicles', 'physical_damage_value'),
    ('cs_intake_vehicles', 'coverage_type'),
    ('cs_intake_drivers', 'cdl_years_experience'),
    ('cs_intake_drivers', 'owner_operator')
  ) as t(tbl, col)
  where not exists (
    select 1 from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = t.tbl and c.column_name = t.col
  );

  if v_missing is not null then
    raise exception 'v1.20.0 cannot run: missing %', v_missing
      using hint = 'Apply v1.18.0 through v1.19.5 first.';
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE FUNCTION
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
  v_assignments text;
  -- What a specialty member may correct on the linked intake.
  --
  -- Grouped the way the workspace's Application tab is grouped, because that is the
  -- screen this list has to keep up with. Anything absent is refused by name, which
  -- is the point of an allow-list over a deny-list: a column added to
  -- cs_intake_submissions tomorrow is not editable from Specialty Quotes until
  -- somebody decides it should be.
  v_allowed text[] := array[
    -- Customer contact
    'insured_first_name', 'insured_middle_name', 'insured_last_name', 'insured_dob',
    'insured_email', 'insured_phone_primary', 'insured_phone_alt',
    'preferred_language', 'preferred_contact',
    'addr_street', 'addr_unit', 'addr_city', 'addr_state', 'addr_zip',
    -- Current / prior policy
    'current_carrier', 'current_policy_number', 'current_premium', 'current_expiration',
    'prior_insurance', 'prior_lapse', 'prior_lapse_explanation',
    'months_continuous_coverage', 'csr_notes',
    -- Business
    'business_name', 'business_type', 'years_in_business', 'ein',
    'dot_number', 'mc_number', 'mcs150_date',
    -- Operations
    'power_unit_count', 'operating_radius_miles', 'states_of_operation',
    'operation_types', 'operation_description', 'desired_effective_date',
    'interstate', 'for_hire', 'radius_band', 'farthest_states_cities',
    'owns_or_leases_trailers', 'owner_operator_count',
    -- Cargo. `cargo_type` is the legacy free-text field and stays editable so a
    -- migrated quote can be corrected; the structured columns are what the
    -- workspace actually asks for.
    'cargo_type', 'primary_commodity', 'cargo_description',
    'broker_load_board', 'commodity_mix_known',
    'typical_load_value', 'max_load_value',
    'requested_cargo_limit', 'cargo_deductible', 'cargo_coverage_desired',
    'refrigerated', 'temperature_controlled_equipment', 'reefer_breakdown_requested',
    'hazmat', 'hazmat_detail', 'excluded_cargo',
    -- Requested coverage
    'auto_liability_limit', 'auto_liability_limit_other', 'um_uim_limit',
    'hired_auto', 'non_owned_auto',
    'physical_damage_needed', 'physical_damage_deductible_requested',
    'pd_comprehensive', 'pd_collision', 'pd_specified_causes',
    'pulls_non_owned_trailers', 'trailer_interchange_agreement',
    'trailer_interchange_limit', 'trailer_interchange_deductible',
    'general_liability_requested', 'general_liability_limit',
    'medical_payments_requested', 'medical_payments_limit',
    'additional_coverages_other',
    'desired_coverage', 'liability_limit',
    'comprehensive_deductible', 'collision_deductible',
    -- Underwriting / loss history
    'uw_coverage_lapse', 'uw_coverage_lapse_detail',
    'uw_cancelled_nonrenewed', 'uw_cancelled_nonrenewed_detail',
    'uw_losses_3yr', 'uw_losses_3yr_detail',
    'uw_major_al_loss', 'uw_major_al_loss_detail',
    'uw_owner_operators', 'uw_owner_operators_detail',
    -- Property
    'property_address_street', 'property_address_unit', 'property_address_city',
    'property_address_state', 'property_address_zip',
    'property_place_id', 'property_formatted', 'property_addr_verified',
    'coverage_type', 'last_roof_update',
    'dwelling_type', 'year_built', 'square_footage',
    'roof_type', 'roof_age', 'coverage_amount', 'prior_claims', 'prior_claims_detail'
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

  for v_key in select jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'Field % cannot be changed from Specialty Quotes.', v_key;
    end if;
    v_updated_keys := v_updated_keys || v_key;
  end loop;

  if array_length(v_updated_keys, 1) > 0 then
    -- Only the supplied keys are assigned, so this is a patch and not an overwrite:
    -- a column absent from p_patch is never named in the SET clause and keeps its
    -- stored value. A key present with a JSON null clears that column, which is how
    -- the intake form itself blanks a field.
    --
    -- jsonb_populate_record does the typing. It is given a NULL row of the table's
    -- own composite type, so each value is cast by the column's real type — text[]
    -- for operation_types, jsonb for excluded_cargo, numeric for the load values —
    -- and a value that cannot be cast raises here rather than being coerced.
    select string_agg(format('%I = p.%I', k, k), ', ' order by k)
      into v_assignments
      from unnest(v_updated_keys) as k;

    execute format(
      'update public.cs_intake_submissions s
          set %s,
              last_edited_by = $2,
              last_edited_at = now(),
              version = s.version + 1,
              updated_at = now()
         from jsonb_populate_record(null::public.cs_intake_submissions, $1) p
        where s.id = $3',
      v_assignments
    ) using p_patch, auth.uid(), v_intake.id;
  end if;

  -- Vehicles and drivers are replace-all when supplied, matching how the intake form
  -- itself saves them, and untouched when the argument is null. Every non-generated
  -- column of each table is carried, so a caller that edits one driver's licence
  -- number does not erase another driver's CDL history.
  if p_vehicles is not null then
    delete from public.cs_intake_vehicles where submission_id = v_intake.id;
    insert into public.cs_intake_vehicles
      (submission_id, position, year, make, model, vin, vin_pending, ownership,
       lienholder, usage, annual_mileage, garaging_zip, coverage,
       truck_type, physical_damage_value, physical_damage_deductible, coverage_type,
       lessor_name, lessor_address)
    select v_intake.id,
           coalesce((r ->> 'position')::integer, ordinality::integer),
           nullif(r ->> 'year', '')::integer, nullif(r ->> 'make', ''), nullif(r ->> 'model', ''),
           -- vin_pending is NOT NULL, so it defaults rather than carrying "unanswered".
           nullif(r ->> 'vin', ''), coalesce((r ->> 'vin_pending')::boolean, false),
           nullif(r ->> 'ownership', ''), nullif(r ->> 'lienholder', ''), nullif(r ->> 'usage', ''),
           nullif(r ->> 'annual_mileage', '')::integer, nullif(r ->> 'garaging_zip', ''),
           -- nullif against the jsonb null, not just coalesce: a NULL column serialises
           -- as `"coverage": null`, and `r -> 'coverage'` returns jsonb 'null' rather
           -- than SQL NULL, so coalesce alone would store the string "null" in a
           -- not-null jsonb column and break every later read of it.
           coalesce(nullif(r -> 'coverage', 'null'::jsonb), '{}'::jsonb),
           nullif(r ->> 'truck_type', ''),
           nullif(r ->> 'physical_damage_value', '')::numeric,
           nullif(r ->> 'physical_damage_deductible', '')::numeric,
           nullif(r ->> 'coverage_type', ''),
           nullif(r ->> 'lessor_name', ''),
           nullif(r ->> 'lessor_address', '')
    from jsonb_array_elements(p_vehicles) with ordinality as t(r, ordinality);
    v_updated_keys := v_updated_keys || 'vehicles';
  end if;

  if p_drivers is not null then
    delete from public.cs_intake_drivers where submission_id = v_intake.id;
    insert into public.cs_intake_drivers
      (submission_id, position, first_name, last_name, dob, relationship, document_type,
       license_number, license_state, license_status, years_licensed, sr22_required, incidents,
       cdl, cdl_date, cdl_years_experience, owner_operator,
       accidents_36mo, accidents_detail, violations_36mo, violations_detail)
    select v_intake.id,
           coalesce((r ->> 'position')::integer, ordinality::integer),
           coalesce(r ->> 'first_name', ''), coalesce(r ->> 'last_name', ''),
           nullif(r ->> 'dob', '')::date, nullif(r ->> 'relationship', ''),
           coalesce(nullif(r ->> 'document_type', ''), 'driver_license'),
           nullif(r ->> 'license_number', ''), nullif(r ->> 'license_state', ''),
           nullif(r ->> 'license_status', ''), nullif(r ->> 'years_licensed', '')::integer,
           -- sr22_required is NOT NULL, so it defaults rather than carrying "unanswered".
           coalesce((r ->> 'sr22_required')::boolean, false),
           coalesce(nullif(r -> 'incidents', 'null'::jsonb), '[]'::jsonb),
           -- These five are nullable, and null means "nobody has answered yet".
           --
           -- Defaulting them to false would turn an unanswered underwriting question into
           -- an answered No — which is worse than leaving it blank, because the blank is
           -- what the readiness check and the workspace's own gap list are looking for. An
           -- underwriter sending an application back for a missing answer is a delay; an
           -- application that says "no accidents" when nobody asked is a misrepresentation.
           nullif(r ->> 'cdl', '')::boolean,
           nullif(r ->> 'cdl_date', '')::date,
           nullif(r ->> 'cdl_years_experience', '')::integer,
           nullif(r ->> 'owner_operator', '')::boolean,
           nullif(r ->> 'accidents_36mo', '')::boolean,
           nullif(r ->> 'accidents_detail', ''),
           nullif(r ->> 'violations_36mo', '')::boolean,
           nullif(r ->> 'violations_detail', '')
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

comment on function public.specialty_update_intake(uuid, jsonb, jsonb, jsonb, integer) is
  'The linked intake edit. Lets an eligible specialty member correct customer, business, operations, cargo, coverage, underwriting, property, vehicle and driver information on the ORIGINAL intake rather than in a competing copy. Authorised by team membership; concurrency-checked against the intake''s own version; written to both the intake event log and the opportunity timeline. The allow-list is the single source of truth for what may change — the UPDATE is built from it, so the two cannot drift. Spec section 20; widened for the workspace redesign in v1.20.0.';

grant execute on function public.specialty_update_intake(uuid, jsonb, jsonb, jsonb, integer) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. POST-CONDITIONS
--
--    Asserted against the stored definition rather than by calling the function,
--    because calling it needs a real opportunity and an authenticated `auth.uid()`.
--    The behavioural proof lives in supabase/verification/v1.20.0-specialty-intake-
--    editing-probe.sql, which exercises it inside a transaction it rolls back.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_def text;
  v_allow_block text;
  v_missing text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'specialty_update_intake'
     and pg_get_function_identity_arguments(p.oid) = 'p_opportunity_id uuid, p_patch jsonb, p_drivers jsonb, p_vehicles jsonb, p_expected_intake_version integer';

  if v_def is null then
    raise exception 'v1.20.0: specialty_update_intake is missing or its signature changed.';
  end if;

  -- The columns the workspace edits must be reachable.
  select string_agg(want, ', ' order by want) into v_missing
    from unnest(array[
      'auto_liability_limit', 'requested_cargo_limit', 'primary_commodity',
      'excluded_cargo', 'trailer_interchange_limit', 'uw_losses_3yr',
      'operation_types', 'ein'
    ]) as want
   where position(want in v_def) = 0;
  if v_missing is not null then
    raise exception 'v1.20.0: allow-list is missing %', v_missing;
  end if;

  -- The replace-all branches must carry the trucking columns, or a driver edit is a
  -- data-loss event. This is the assertion that would have caught the old defect.
  select string_agg(want, ', ' order by want) into v_missing
    from unnest(array[
      'truck_type', 'physical_damage_value', 'physical_damage_deductible',
      'cdl_years_experience', 'owner_operator', 'violations_detail'
    ]) as want
   where position(want in v_def) = 0;
  if v_missing is not null then
    raise exception 'v1.20.0: driver/vehicle replace-all is still missing %', v_missing;
  end if;

  -- An unanswered underwriting question must stay unanswered. Defaulting any of these
  -- four to false would make the application assert something nobody was asked.
  select string_agg(want, ', ' order by want) into v_missing
    from unnest(array[
      'cdl', 'owner_operator', 'accidents_36mo', 'violations_36mo'
    ]) as want
   where position(format('coalesce((r ->> ''%s'')::boolean, false)', want) in v_def) > 0;
  if v_missing is not null then
    raise exception
      'v1.20.0: % would be stored as false when unanswered — an underwriting answer nobody gave.',
      v_missing;
  end if;

  -- The jsonb passthroughs must survive a jsonb null, or a not-null column ends up
  -- holding the string "null".
  if position('nullif(r -> ''incidents'', ''null''::jsonb)' in v_def) = 0
     or position('nullif(r -> ''coverage'', ''null''::jsonb)' in v_def) = 0 then
    raise exception 'v1.20.0: the jsonb passthroughs do not guard against a jsonb null.';
  end if;

  -- Still an allow-list. If the guard clause went away, everything above is moot.
  if position('cannot be changed from Specialty Quotes' in v_def) = 0 then
    raise exception 'v1.20.0: the field guard is gone — every column would be editable.';
  end if;
  if position('specialty_can_edit_opportunity' in v_def) = 0 then
    raise exception 'v1.20.0: the authorization check is gone.';
  end if;
  if position('40001' in v_def) = 0 then
    raise exception 'v1.20.0: the intake-version concurrency refusal is gone.';
  end if;

  -- Nothing that decides where an intake sits in its own lifecycle may be listed.
  -- Scoped to the allow-list literal, because words like `version` legitimately appear
  -- elsewhere in the body — in the concurrency check and in the return shape.
  v_allow_block := split_part(split_part(v_def, 'v_allowed text[] := array[', 2), '];', 1);
  if v_allow_block = '' then
    raise exception 'v1.20.0: the allow-list array could not be located in the stored definition.';
  end if;

  select string_agg(forbidden, ', ' order by forbidden) into v_missing
    from unnest(array[
      '''status''', '''version''', '''submission_id''', '''created_by''',
      '''converted_at''', '''converted_work_item_id''', '''is_walk_in''', '''channel''',
      '''line_of_business'''
    ]) as forbidden
   where position(forbidden in v_allow_block) > 0;
  if v_missing is not null then
    raise exception 'v1.20.0: refuse-list breach — the allow-list now names %', v_missing;
  end if;

  raise notice 'v1.20.0: specialty_update_intake accepts the workspace fields and preserves trucking detail.';
end;
$$;
