-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.19.5 verification probe — Homeowners intake, the exact failing path
--
-- Reproduces what the browser does, as a real Customer Service employee under
-- RLS, and proves the six new columns survive a save instead of erroring or
-- being silently discarded.
--
--   Probe 1  The new create path: seed insert (created_by + line_of_business
--            only) followed by cs_intake_save_draft carrying all six fields.
--            Proves the answers persist.
--   Probe 2  The old create path: a direct insert that names coverage_type and
--            the other five columns. This is the statement that produced
--            "Could not find the 'coverage_type' column ... in the schema
--            cache". Proves the schema now accepts it, so any other client that
--            still writes this shape is fixed too.
--   Probe 3  specialty_opportunity_detail returns the six fields.
--   Probe 4  specialty_update_intake accepts coverage_type in its patch
--            allow-list instead of refusing the field.
--
-- Every check raises on failure, so a non-zero exit is the whole result. The
-- probe rolls itself back: nothing it writes is kept.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

set local role authenticated;
-- Alejandro Barros, customer_service. Impersonated so auth.uid() resolves and
-- the same RLS policies a real request hits are the ones exercised here.
set local request.jwt.claims = '{"sub":"c9b963ef-8910-4e64-89d2-dabd469089aa","role":"authenticated"}';

do $probe$
declare
  c_me constant uuid := 'c9b963ef-8910-4e64-89d2-dabd469089aa';
  v_id uuid;
  v_id2 uuid;
  v_saved public.cs_intake_submissions;
  v_opp uuid;
  v_detail jsonb;
  v_intake jsonb;
  v_result jsonb;
begin
  -- ─── Probe 1: seed insert, then the filtered RPC carries the answers ────────
  insert into public.cs_intake_submissions (created_by, line_of_business)
  values (c_me, 'homeowners')
  returning id into v_id;

  perform public.cs_intake_save_draft(
    v_id,
    jsonb_build_object(
      'insured_first_name', 'Probe',
      'insured_last_name', 'Homeowner',
      'insured_phone_primary', '7045550199',
      'line_of_business', 'homeowners',
      'coverage_type', 'Mobile Home',
      'property_address_street', '412 Probe Lane',
      'property_address_unit', 'Apt 7B',
      'property_address_city', 'Charlotte',
      'property_address_state', 'NC',
      'property_address_zip', '28205',
      'property_place_id', 'probe_place_id_xyz',
      'property_formatted', '412 Probe Lane Apt 7B, Charlotte, NC 28205',
      'property_addr_verified', true,
      'dwelling_type', 'Mobile Home',
      'year_built', 1998,
      'roof_age', 6,
      'last_roof_update', 'about 2019, owner is not sure',
      'coverage_amount', 185000
    ),
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    1
  );

  select * into v_saved from public.cs_intake_submissions where id = v_id;

  if v_saved.coverage_type is distinct from 'Mobile Home' then
    raise exception 'Probe 1: coverage_type did not persist (got %)', v_saved.coverage_type;
  end if;
  if v_saved.property_address_unit is distinct from 'Apt 7B' then
    raise exception 'Probe 1: property_address_unit did not persist (got %)', v_saved.property_address_unit;
  end if;
  if v_saved.property_place_id is distinct from 'probe_place_id_xyz' then
    raise exception 'Probe 1: property_place_id did not persist (got %)', v_saved.property_place_id;
  end if;
  if v_saved.property_formatted is null then
    raise exception 'Probe 1: property_formatted did not persist';
  end if;
  if v_saved.property_addr_verified is not true then
    raise exception 'Probe 1: property_addr_verified did not persist (got %)', v_saved.property_addr_verified;
  end if;
  if v_saved.last_roof_update is distinct from 'about 2019, owner is not sure' then
    raise exception 'Probe 1: last_roof_update did not persist (got %)', v_saved.last_roof_update;
  end if;
  -- The pre-existing columns must be untouched by the change.
  if v_saved.property_address_street is distinct from '412 Probe Lane'
     or v_saved.coverage_amount is distinct from 185000
     or v_saved.dwelling_type is distinct from 'Mobile Home' then
    raise exception 'Probe 1: an existing homeowners column regressed';
  end if;
  -- The seed insert must not have left the row on the 'auto' default.
  if v_saved.line_of_business::text <> 'homeowners' then
    raise exception 'Probe 1: line_of_business is % after a homeowners seed', v_saved.line_of_business;
  end if;
  raise notice 'Probe 1 passed: all six fields persisted through cs_intake_save_draft.';

  -- ─── Probe 2: the shape that used to fail outright ──────────────────────────
  insert into public.cs_intake_submissions (
    created_by, line_of_business, insured_first_name, insured_last_name,
    insured_phone_primary,
    coverage_type, property_address_street, property_address_unit,
    property_place_id, property_formatted, property_addr_verified,
    last_roof_update
  ) values (
    c_me, 'homeowners', 'Probe', 'Direct', '7045550200',
    'Landlord', '9 Direct Way', 'Unit 3',
    'probe_direct_place', '9 Direct Way Unit 3', true,
    '2021'
  )
  returning id into v_id2;

  if not exists (
    select 1 from public.cs_intake_submissions
    where id = v_id2 and coverage_type = 'Landlord' and property_addr_verified
  ) then
    raise exception 'Probe 2: the direct insert did not store what it named';
  end if;
  raise notice 'Probe 2 passed: the insert that raised the schema-cache error now succeeds.';

  -- ─── Probe 3: the quoting team can read the new fields ──────────────────────
  v_opp := public.cs_intake_submit_specialty(v_id);

  -- The submitting CSR is not on the quoting team and cannot view or edit the
  -- opportunity, so probes 3 and 4 run as a manager. Byron's account is
  -- super_admin, which both specialty gates honour.
  perform set_config(
    'request.jwt.claims',
    (select json_build_object('sub', p.id, 'role', 'authenticated')::text
       from public.profiles p where p.role = 'super_admin' and p.is_active limit 1),
    true
  );

  v_detail := public.specialty_opportunity_detail(v_opp);
  v_intake := v_detail -> 'intake';

  if v_intake ->> 'coverage_type' is distinct from 'Mobile Home' then
    raise exception 'Probe 3: specialty detail omits coverage_type (got %)', v_intake ->> 'coverage_type';
  end if;
  if v_intake ->> 'property_address_unit' is distinct from 'Apt 7B' then
    raise exception 'Probe 3: specialty detail omits property_address_unit';
  end if;
  if (v_intake ->> 'property_addr_verified')::boolean is not true then
    raise exception 'Probe 3: specialty detail omits property_addr_verified';
  end if;
  if v_intake ->> 'last_roof_update' is null then
    raise exception 'Probe 3: specialty detail omits last_roof_update';
  end if;
  if v_intake ->> 'property_place_id' is null or v_intake ->> 'property_formatted' is null then
    raise exception 'Probe 3: specialty detail omits the place id / formatted address';
  end if;
  -- Trucking fields the same function returns must still be there.
  if not (v_intake ? 'dot_number' and v_intake ? 'auto_liability_limit' and v_intake ? 'trailers') then
    raise exception 'Probe 3: the trucking half of specialty_opportunity_detail regressed';
  end if;
  raise notice 'Probe 3 passed: specialty_opportunity_detail returns all six fields.';

  -- ─── Probe 4: a specialty member may correct them ───────────────────────────
  v_result := public.specialty_update_intake(
    v_opp,
    jsonb_build_object(
      'coverage_type', 'Landlord',
      'property_address_unit', 'Apt 9C',
      'last_roof_update', '2023',
      'property_addr_verified', false
    ),
    null, null, null
  );

  select * into v_saved from public.cs_intake_submissions where id = v_id;
  if v_saved.coverage_type is distinct from 'Landlord' then
    raise exception 'Probe 4: specialty_update_intake did not apply coverage_type (got %)', v_saved.coverage_type;
  end if;
  if v_saved.property_address_unit is distinct from 'Apt 9C' then
    raise exception 'Probe 4: specialty_update_intake did not apply property_address_unit';
  end if;
  if v_saved.last_roof_update is distinct from '2023' then
    raise exception 'Probe 4: specialty_update_intake did not apply last_roof_update';
  end if;
  if v_saved.property_addr_verified is not false then
    raise exception 'Probe 4: specialty_update_intake could not clear property_addr_verified';
  end if;
  -- A field genuinely outside the allow-list must still be refused, so the
  -- widened list did not become a free-for-all.
  begin
    perform public.specialty_update_intake(v_opp, jsonb_build_object('status', 'converted'), null, null, null);
    raise exception 'Probe 4: specialty_update_intake accepted a protected field';
  exception
    when others then
      if sqlerrm not like '%cannot be changed from Specialty Quotes%' then raise; end if;
  end;
  raise notice 'Probe 4 passed: the new fields are editable and protected fields are still refused.';

  raise notice 'ALL PROBES PASSED.';
end;
$probe$;

-- Nothing this probe wrote is kept.
rollback;
