-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.19.2 — Trucking Intake Underwriting Upgrade
--
-- Extends the EXISTING trucking intake so Customer Service can capture the
-- underwriting information carriers actually require, without creating a
-- carrier-specific form. Everything here is additive.
--
-- Sections
--   1. Operations                — operation types, radius band, interstate, for hire
--   2. Requested Coverages       — AL, Physical Damage, Cargo, Trailer Interchange, other
--   3. Underwriting / Eligibility — 6 yes/no questions + conditional detail
--   4. Current policy            — lapse explanation
--   5. Drivers                   — CDL experience, owner/operator, accidents, violations
--   6. Vehicles                  — lessor information when leased
--   7. Commodities               — percent hauled, average value, maximum value
--   8. NEW TABLE cs_intake_trailers (+ RLS)
--   9. cs_intake_save_draft      — replaced: adds p_trailers and the new child columns
--
-- DELIBERATE REUSE — these already exist and are NOT duplicated:
--   states_of_operation        → "States Traveled"
--   requested_cargo_limit      → "Desired Cargo Limit"
--   cargo_deductible           → "Cargo Deductible"
--   refrigerated               → refrigeration applicability
--   reefer_breakdown_requested → "Refrigeration Breakdown"
--   hazmat                     → the hazmat underwriting question
--   cs_intake_vehicles.physical_damage_value / _deductible → per-vehicle ACV
--
-- BACKWARD COMPATIBILITY
--   business_type and operating_radius_miles are kept populated by the client as
--   derived values (joined operation labels / representative mileage) so existing
--   saved intakes, server validation and reporting continue to work unchanged.
--
-- SAFETY
--   Only `add column if not exists`; the base DDL for cs_intake_submissions,
--   cs_intake_drivers and cs_intake_vehicles is live-only and is not touched.
--   No CHECK constraints are added to the new option varchars, matching the
--   existing hazmat / reefer_breakdown_requested convention, so an unexpected UI
--   value can never make a save fail.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. OPERATIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Selectable operation types, replacing free-text "Type of Work". An array
-- because a carrier commonly runs more than one (e.g. Local Delivery + Regional).
alter table public.cs_intake_submissions
  add column if not exists operation_types text[];

comment on column public.cs_intake_submissions.operation_types is
  'Selected trucking operation types: local_delivery, regional, long_haul, hotshot, dump, auto_hauling, moving, construction, towing, other. business_type is kept in sync with the joined labels for backward compatibility.';

alter table public.cs_intake_submissions
  add column if not exists operation_description text;

alter table public.cs_intake_submissions
  add column if not exists desired_effective_date date;

alter table public.cs_intake_submissions
  add column if not exists interstate boolean;

alter table public.cs_intake_submissions
  add column if not exists for_hire boolean;

-- Banded radius. operating_radius_miles stays populated with a representative
-- numeric value so existing validation and reporting keep working.
alter table public.cs_intake_submissions
  add column if not exists radius_band varchar(20);

comment on column public.cs_intake_submissions.radius_band is
  'Operating radius band: 0_50, 51_100, 101_200, 201_300, 301_500, 500_plus. operating_radius_miles holds a representative numeric value derived from this.';

alter table public.cs_intake_submissions
  add column if not exists farthest_states_cities text;

comment on column public.cs_intake_submissions.farthest_states_cities is
  'Farthest states / cities travelled. Collected only when radius_band = 500_plus.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. REQUESTED COVERAGES
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── Auto Liability
alter table public.cs_intake_submissions
  add column if not exists auto_liability_limit varchar(30);

comment on column public.cs_intake_submissions.auto_liability_limit is
  'Desired Auto Liability limit: 300000, 500000, 750000, 1000000, or other. This is Auto Liability, not General Liability.';

alter table public.cs_intake_submissions
  add column if not exists auto_liability_limit_other varchar(60);

alter table public.cs_intake_submissions
  add column if not exists um_uim_limit varchar(60);

alter table public.cs_intake_submissions
  add column if not exists hired_auto varchar(12);

comment on column public.cs_intake_submissions.hired_auto is
  'Hired Auto requested: yes, no, not_sure.';

alter table public.cs_intake_submissions
  add column if not exists non_owned_auto varchar(12);

comment on column public.cs_intake_submissions.non_owned_auto is
  'Non-Owned Auto requested: yes, no, not_sure.';

-- ── Physical Damage
alter table public.cs_intake_submissions
  add column if not exists physical_damage_needed boolean;

comment on column public.cs_intake_submissions.physical_damage_needed is
  'Whether Physical Damage coverage is wanted at all. When false, per-vehicle ACV and PD deductible must not block submission.';

alter table public.cs_intake_submissions
  add column if not exists physical_damage_deductible_requested varchar(30);

alter table public.cs_intake_submissions
  add column if not exists pd_comprehensive boolean;

alter table public.cs_intake_submissions
  add column if not exists pd_collision boolean;

alter table public.cs_intake_submissions
  add column if not exists pd_specified_causes boolean;

-- ── Trailer Interchange
alter table public.cs_intake_submissions
  add column if not exists pulls_non_owned_trailers boolean;

comment on column public.cs_intake_submissions.pulls_non_owned_trailers is
  'Does the insured pull trailers they do not own? Gates the Trailer Interchange questions.';

alter table public.cs_intake_submissions
  add column if not exists trailer_interchange_agreement boolean;

alter table public.cs_intake_submissions
  add column if not exists trailer_interchange_limit varchar(30);

alter table public.cs_intake_submissions
  add column if not exists trailer_interchange_deductible varchar(30);

-- ── Additional coverages (collapsed unless selected)
alter table public.cs_intake_submissions
  add column if not exists general_liability_requested boolean;

alter table public.cs_intake_submissions
  add column if not exists general_liability_limit varchar(60);

alter table public.cs_intake_submissions
  add column if not exists medical_payments_requested boolean;

alter table public.cs_intake_submissions
  add column if not exists medical_payments_limit varchar(60);

alter table public.cs_intake_submissions
  add column if not exists additional_coverages_other text;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. UNDERWRITING / ELIGIBILITY
--
--    Six primary questions. Each stores a boolean plus a conditional detail
--    field revealed only when the answer is Yes. The hazmat question reuses the
--    existing `hazmat` column so Customer Service is never asked twice; only its
--    detail field is new.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.cs_intake_submissions
  add column if not exists uw_coverage_lapse boolean;
alter table public.cs_intake_submissions
  add column if not exists uw_coverage_lapse_detail text;

alter table public.cs_intake_submissions
  add column if not exists uw_cancelled_nonrenewed boolean;
alter table public.cs_intake_submissions
  add column if not exists uw_cancelled_nonrenewed_detail text;

alter table public.cs_intake_submissions
  add column if not exists uw_losses_3yr boolean;
alter table public.cs_intake_submissions
  add column if not exists uw_losses_3yr_detail text;

alter table public.cs_intake_submissions
  add column if not exists uw_major_al_loss boolean;
alter table public.cs_intake_submissions
  add column if not exists uw_major_al_loss_detail text;

-- Reuses the existing `hazmat` varchar for the answer.
alter table public.cs_intake_submissions
  add column if not exists hazmat_detail text;

comment on column public.cs_intake_submissions.hazmat_detail is
  'Explanation for the hazmat underwriting question. The answer itself lives on the pre-existing hazmat column so the question is only asked once.';

alter table public.cs_intake_submissions
  add column if not exists uw_owner_operators boolean;
alter table public.cs_intake_submissions
  add column if not exists uw_owner_operators_detail text;
alter table public.cs_intake_submissions
  add column if not exists owner_operator_count integer;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. TRAILER SECTION GATE + CURRENT POLICY
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.cs_intake_submissions
  add column if not exists owns_or_leases_trailers boolean;

comment on column public.cs_intake_submissions.owns_or_leases_trailers is
  'Does the insured own or lease trailers? Gates the whole trailer section.';

alter table public.cs_intake_submissions
  add column if not exists prior_lapse_explanation text;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. DRIVER ENHANCEMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.cs_intake_drivers
  add column if not exists cdl_years_experience integer;

comment on column public.cs_intake_drivers.cdl_years_experience is
  'Years of CDL experience. Collected only when cdl = true. CDL experience begins when the full CDL is obtained, not the permit.';

alter table public.cs_intake_drivers
  add column if not exists owner_operator boolean default false;

alter table public.cs_intake_drivers
  add column if not exists accidents_36mo boolean default false;
alter table public.cs_intake_drivers
  add column if not exists accidents_detail text;

alter table public.cs_intake_drivers
  add column if not exists violations_36mo boolean default false;
alter table public.cs_intake_drivers
  add column if not exists violations_detail text;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. VEHICLE ENHANCEMENTS — lessor information when leased
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.cs_intake_vehicles
  add column if not exists lessor_name text;

alter table public.cs_intake_vehicles
  add column if not exists lessor_address text;

comment on column public.cs_intake_vehicles.lessor_name is
  'Lessor / additional insured. Revealed only when ownership = leased.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. COMMODITY DETAIL — percent hauled and load values per commodity
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.cs_intake_commodities
  add column if not exists percent_hauled numeric(5,2);

alter table public.cs_intake_commodities
  add column if not exists average_value numeric(12,2);

alter table public.cs_intake_commodities
  add column if not exists maximum_value numeric(12,2);

comment on column public.cs_intake_commodities.percent_hauled is
  'Share of hauling this commodity represents. The form validates that the selected commodities total approximately 100%.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. NEW CHILD TABLE — cs_intake_trailers
--
--    Trucking trailers are a real list, not scalar fields: a carrier can own
--    several and each needs its own year / make / type / VIN / ACV. The existing
--    trailer_* columns on the parent belong to the unrelated personal
--    Trailer/Mobile-Home line of business and are deliberately left alone.
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.cs_intake_trailers (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.cs_intake_submissions(id) on delete cascade,
  position integer not null default 1,
  year integer,
  make text,
  trailer_type varchar(50),
  vin text,
  actual_cash_value numeric(12,2),
  ownership varchar(20) default 'owned',
  lessor_name text,
  lessor_address text,
  created_at timestamptz not null default now()
);

comment on table public.cs_intake_trailers is
  'Trailers the insured owns or leases, for the trucking line of business. Gated in the form by cs_intake_submissions.owns_or_leases_trailers. Feeds the Trailer Information table on carrier applications.';

create index if not exists cs_intake_trailers_submission_idx
  on public.cs_intake_trailers (submission_id, position);

-- RLS mirrors cs_intake_commodities: readable by any authenticated user, writes
-- gated on edit rights to the parent intake. Policies are dropped first so this
-- migration stays safe to retry.
alter table public.cs_intake_trailers enable row level security;

drop policy if exists cs_intake_trailers_select on public.cs_intake_trailers;
create policy cs_intake_trailers_select
  on public.cs_intake_trailers for select to authenticated
  using (true);

drop policy if exists cs_intake_trailers_insert on public.cs_intake_trailers;
create policy cs_intake_trailers_insert
  on public.cs_intake_trailers for insert to authenticated
  with check (public.can_edit_cs_intake(submission_id));

drop policy if exists cs_intake_trailers_update on public.cs_intake_trailers;
create policy cs_intake_trailers_update
  on public.cs_intake_trailers for update to authenticated
  using (public.can_edit_cs_intake(submission_id));

drop policy if exists cs_intake_trailers_delete on public.cs_intake_trailers;
create policy cs_intake_trailers_delete
  on public.cs_intake_trailers for delete to authenticated
  using (public.can_edit_cs_intake(submission_id));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. REPLACE cs_intake_save_draft
--
--    The parent row is written through a dynamic information_schema whitelist, so
--    every new column in sections 1-4 above persists without any change here.
--    What DOES need changing is the hard-coded child INSERT lists, plus the new
--    p_trailers parameter — which alters the signature, so the 7-param version is
--    dropped first to avoid overload ambiguity (the v1.18.0 precedent).
-- ═══════════════════════════════════════════════════════════════════════════════

drop function if exists public.cs_intake_save_draft(uuid, jsonb, jsonb, jsonb, jsonb, jsonb, integer);

create or replace function public.cs_intake_save_draft(
  p_submission_id uuid,
  p_payload jsonb,
  p_drivers jsonb default '[]'::jsonb,
  p_vehicles jsonb default '[]'::jsonb,
  p_owners jsonb default '[]'::jsonb,
  p_commodities jsonb default '[]'::jsonb,
  p_trailers jsonb default '[]'::jsonb,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  c_protected constant text[] := array[
    'id', 'status', 'created_by', 'created_at', 'updated_at', 'submitted_at',
    'claimed_by', 'claimed_at', 'converted_at', 'work_item_id',
    'source_work_item_id', 'version', 'completed_by', 'last_edited_by',
    'last_edited_at', 'source_commercial_quote_id', 'source_renewal_id',
    'priority', 'return_reason', 'reject_reason'
  ];
  v_row public.cs_intake_submissions%rowtype;
  v_old jsonb;
  v_payload jsonb;
  v_normalized jsonb;
  v_keys text[];
  v_set_list text;
  v_changed jsonb;
  v_new_version integer;
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'Sign in to save this intake.';
  end if;

  -- ─── Guard: row must exist and be editable ──────────────────────────────────
  select * into v_row from public.cs_intake_submissions where id = p_submission_id for update;
  if not found then raise exception 'Submission % not found.', p_submission_id; end if;

  if not public.can_edit_cs_intake(p_submission_id) then
    raise exception 'You cannot edit this intake.';
  end if;

  if v_row.source_work_item_id is not null
     and v_row.status::text not in ('draft', 'returned') then
    raise exception 'This intake has already become a quote. Add a note instead of changing the original intake.';
  end if;

  if v_row.status not in ('draft', 'returned') then
    raise exception 'Cannot edit a submission in status "%".', v_row.status;
  end if;

  -- ─── Optimistic concurrency check ──────────────────────────────────────────
  if p_expected_version is not null and v_row.version <> p_expected_version then
    raise exception
      'This intake was updated by another employee while you were working on it. Review the latest information before saving.'
      using errcode = '40001';
  end if;

  -- ─── Diff: build the list of changed scalar fields ─────────────────────────
  v_old := to_jsonb(v_row);
  v_payload := coalesce(p_payload, '{}'::jsonb) - c_protected;

  -- Legacy label normalisation
  if v_payload ->> 'line_of_business' = 'personal_auto' then
    v_payload := jsonb_set(v_payload, '{line_of_business}', '"auto"'::jsonb);
  end if;

  -- "Same as Customer Address" — settled server-side so addresses never drift
  if coalesce((v_payload ->> 'renters_same_as_customer')::boolean, false) then
    v_payload := v_payload
      || jsonb_build_object(
           'renters_property_address', coalesce(v_payload ->> 'addr_street', v_row.addr_street),
           'renters_city', coalesce(v_payload ->> 'addr_city', v_row.addr_city),
           'renters_state', coalesce(v_payload ->> 'addr_state', v_row.addr_state),
           'renters_zip', coalesce(v_payload ->> 'addr_zip', v_row.addr_zip),
           'renters_unit', coalesce(v_payload ->> 'addr_unit', v_row.addr_unit),
           'renters_place_id', coalesce(v_payload ->> 'addr_place_id', v_row.addr_place_id),
           'renters_formatted', coalesce(v_payload ->> 'addr_formatted', v_row.addr_formatted),
           'renters_addr_verified',
             coalesce((v_payload ->> 'addr_verified')::boolean, v_row.addr_verified)
         );
  end if;

  -- Normalize: keep only real columns, turn empty strings into null for non-text
  -- columns (a cleared date arrives from the browser as "" and ''::date errors).
  select coalesce(
           jsonb_object_agg(
             c.column_name,
             case
               when (v_payload ->> c.column_name) = ''
                    and c.data_type not in ('text', 'character varying')
                 then 'null'::jsonb
               else v_payload -> c.column_name
             end
           ),
           '{}'::jsonb
         )
  into v_normalized
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'cs_intake_submissions'
    and v_payload ? c.column_name;

  v_payload := v_normalized;

  select array_agg(k order by k)
  into v_keys
  from jsonb_object_keys(v_payload) as k;

  -- ─── Apply scalar update via jsonb_populate_record (handles type casts) ────
  if v_keys is not null and array_length(v_keys, 1) > 0 then
    select string_agg(format('%I = r.%I', k, k), ', ')
    into v_set_list
    from unnest(v_keys) as k;

    execute format(
      'update public.cs_intake_submissions s
          set %s
         from jsonb_populate_record(null::public.cs_intake_submissions, $1) as r
        where s.id = $2',
      v_set_list
    ) using v_payload, p_submission_id;
  end if;

  -- Field-level change list for the timeline
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'field', k,
               'old_value', v_old ->> k,
               'new_value', v_payload ->> k
             )
             order by k
           ),
           '[]'::jsonb
         )
  into v_changed
  from unnest(coalesce(v_keys, array[]::text[])) as k
  where coalesce(v_old ->> k, '') is distinct from coalesce(v_payload ->> k, '');

  -- Bump version
  update public.cs_intake_submissions
  set version = version + 1,
      last_edited_by = v_actor,
      last_edited_at = now(),
      updated_at = now()
  where id = p_submission_id
  returning version into v_new_version;

  -- ─── Children: drivers ──────────────────────────────────────────────────────
  delete from public.cs_intake_drivers where submission_id = p_submission_id;
  if jsonb_typeof(coalesce(p_drivers, '[]'::jsonb)) = 'array'
     and jsonb_array_length(coalesce(p_drivers, '[]'::jsonb)) > 0 then
    insert into public.cs_intake_drivers (
      submission_id, position, first_name, last_name, dob, relationship,
      document_type, license_number, license_state, license_status,
      years_licensed, sr22_required, incidents, cdl, cdl_date,
      cdl_years_experience, owner_operator,
      accidents_36mo, accidents_detail, violations_36mo, violations_detail
    )
    select
      p_submission_id,
      item.ordinality::integer,
      coalesce(item.value ->> 'first_name', ''),
      coalesce(item.value ->> 'last_name', ''),
      nullif(item.value ->> 'dob', '')::date,
      nullif(item.value ->> 'relationship', ''),
      coalesce(nullif(item.value ->> 'document_type', ''), 'driver_license'),
      nullif(item.value ->> 'license_number', ''),
      nullif(item.value ->> 'license_state', ''),
      nullif(item.value ->> 'license_status', ''),
      nullif(item.value ->> 'years_licensed', '')::integer,
      coalesce(nullif(item.value ->> 'sr22_required', '')::boolean, false),
      coalesce(item.value -> 'incidents', '[]'::jsonb),
      coalesce(nullif(item.value ->> 'cdl', '')::boolean, false),
      nullif(item.value ->> 'cdl_date', '')::date,
      nullif(item.value ->> 'cdl_years_experience', '')::integer,
      coalesce(nullif(item.value ->> 'owner_operator', '')::boolean, false),
      coalesce(nullif(item.value ->> 'accidents_36mo', '')::boolean, false),
      nullif(item.value ->> 'accidents_detail', ''),
      coalesce(nullif(item.value ->> 'violations_36mo', '')::boolean, false),
      nullif(item.value ->> 'violations_detail', '')
    from jsonb_array_elements(p_drivers) with ordinality as item(value, ordinality);
  end if;

  -- ─── Children: vehicles ─────────────────────────────────────────────────────
  delete from public.cs_intake_vehicles where submission_id = p_submission_id;
  if jsonb_typeof(coalesce(p_vehicles, '[]'::jsonb)) = 'array'
     and jsonb_array_length(coalesce(p_vehicles, '[]'::jsonb)) > 0 then
    insert into public.cs_intake_vehicles (
      submission_id, position, year, make, model, vin, vin_pending,
      ownership, lienholder, usage, annual_mileage, garaging_zip, coverage,
      truck_type, physical_damage_value, physical_damage_deductible,
      coverage_type, lessor_name, lessor_address
    )
    select
      p_submission_id,
      item.ordinality::integer,
      nullif(item.value ->> 'year', '')::integer,
      nullif(item.value ->> 'make', ''),
      nullif(item.value ->> 'model', ''),
      nullif(item.value ->> 'vin', ''),
      coalesce(nullif(item.value ->> 'vin_pending', '')::boolean, false),
      nullif(item.value ->> 'ownership', ''),
      nullif(item.value ->> 'lienholder', ''),
      nullif(item.value ->> 'usage', ''),
      nullif(item.value ->> 'annual_mileage', '')::integer,
      nullif(item.value ->> 'garaging_zip', ''),
      coalesce(item.value -> 'coverage', '{}'::jsonb),
      nullif(item.value ->> 'truck_type', ''),
      nullif(item.value ->> 'physical_damage_value', '')::numeric,
      nullif(item.value ->> 'physical_damage_deductible', '')::numeric,
      nullif(item.value ->> 'coverage_type', ''),
      nullif(item.value ->> 'lessor_name', ''),
      nullif(item.value ->> 'lessor_address', '')
    from jsonb_array_elements(p_vehicles) with ordinality as item(value, ordinality);
  end if;

  -- ─── Children: owners ───────────────────────────────────────────────────────
  delete from public.cs_intake_owners where submission_id = p_submission_id;
  if jsonb_typeof(coalesce(p_owners, '[]'::jsonb)) = 'array'
     and jsonb_array_length(coalesce(p_owners, '[]'::jsonb)) > 0 then
    insert into public.cs_intake_owners (
      submission_id, position, first_name, middle_name, last_name,
      dob, phone, email, ownership_percentage
    )
    select
      p_submission_id,
      item.ordinality::integer,
      coalesce(item.value ->> 'first_name', ''),
      nullif(item.value ->> 'middle_name', ''),
      coalesce(item.value ->> 'last_name', ''),
      nullif(item.value ->> 'dob', '')::date,
      nullif(item.value ->> 'phone', ''),
      nullif(item.value ->> 'email', ''),
      nullif(item.value ->> 'ownership_percentage', '')::numeric
    from jsonb_array_elements(p_owners) with ordinality as item(value, ordinality);
  end if;

  -- ─── Children: commodities ─────────────────────────────────────────────────
  delete from public.cs_intake_commodities where submission_id = p_submission_id;
  if jsonb_typeof(coalesce(p_commodities, '[]'::jsonb)) = 'array'
     and jsonb_array_length(coalesce(p_commodities, '[]'::jsonb)) > 0 then
    insert into public.cs_intake_commodities (
      submission_id, category, frequency, is_primary,
      percent_hauled, average_value, maximum_value
    )
    select
      p_submission_id,
      coalesce(item.value ->> 'category', ''),
      coalesce(nullif(item.value ->> 'frequency', ''), 'mostly'),
      coalesce(nullif(item.value ->> 'is_primary', '')::boolean, false),
      nullif(item.value ->> 'percent_hauled', '')::numeric,
      nullif(item.value ->> 'average_value', '')::numeric,
      nullif(item.value ->> 'maximum_value', '')::numeric
    from jsonb_array_elements(p_commodities) as item(value)
    where coalesce(item.value ->> 'category', '') <> '';
  end if;

  -- ─── Children: trailers (new in v1.19.2) ───────────────────────────────────
  delete from public.cs_intake_trailers where submission_id = p_submission_id;
  if jsonb_typeof(coalesce(p_trailers, '[]'::jsonb)) = 'array'
     and jsonb_array_length(coalesce(p_trailers, '[]'::jsonb)) > 0 then
    insert into public.cs_intake_trailers (
      submission_id, position, year, make, trailer_type, vin,
      actual_cash_value, ownership, lessor_name, lessor_address
    )
    select
      p_submission_id,
      item.ordinality::integer,
      nullif(item.value ->> 'year', '')::integer,
      nullif(item.value ->> 'make', ''),
      nullif(item.value ->> 'trailer_type', ''),
      nullif(item.value ->> 'vin', ''),
      nullif(item.value ->> 'actual_cash_value', '')::numeric,
      coalesce(nullif(item.value ->> 'ownership', ''), 'owned'),
      nullif(item.value ->> 'lessor_name', ''),
      nullif(item.value ->> 'lessor_address', '')
    from jsonb_array_elements(p_trailers) with ordinality as item(value, ordinality);
  end if;

  -- Audit
  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (
    p_submission_id,
    v_actor,
    'draft_updated',
    jsonb_build_object(
      'version', v_new_version,
      'status_at_save', v_row.status::text,
      'changed_field_count', jsonb_array_length(v_changed),
      'changed_fields', v_changed
    )
  );

  return jsonb_build_object(
    'id', p_submission_id,
    'version', v_new_version,
    'changed_fields', v_changed
  );
end;
$fn$;

revoke execute on function public.cs_intake_save_draft(uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, integer) from public, anon;
grant execute on function public.cs_intake_save_draft(uuid, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════

do $verify$
declare
  v_missing text;
  v_fn_count integer;
begin
  -- Every new parent column must exist.
  select string_agg(c.name, ', ')
  into v_missing
  from (values
    ('operation_types'), ('operation_description'), ('desired_effective_date'),
    ('interstate'), ('for_hire'), ('radius_band'), ('farthest_states_cities'),
    ('auto_liability_limit'), ('auto_liability_limit_other'), ('um_uim_limit'),
    ('hired_auto'), ('non_owned_auto'),
    ('physical_damage_needed'), ('physical_damage_deductible_requested'),
    ('pd_comprehensive'), ('pd_collision'), ('pd_specified_causes'),
    ('pulls_non_owned_trailers'), ('trailer_interchange_agreement'),
    ('trailer_interchange_limit'), ('trailer_interchange_deductible'),
    ('general_liability_requested'), ('general_liability_limit'),
    ('medical_payments_requested'), ('medical_payments_limit'),
    ('additional_coverages_other'),
    ('uw_coverage_lapse'), ('uw_coverage_lapse_detail'),
    ('uw_cancelled_nonrenewed'), ('uw_cancelled_nonrenewed_detail'),
    ('uw_losses_3yr'), ('uw_losses_3yr_detail'),
    ('uw_major_al_loss'), ('uw_major_al_loss_detail'),
    ('hazmat_detail'),
    ('uw_owner_operators'), ('uw_owner_operators_detail'), ('owner_operator_count'),
    ('owns_or_leases_trailers'), ('prior_lapse_explanation')
  ) as c(name)
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'cs_intake_submissions'
      and column_name = c.name
  );

  if v_missing is not null then
    raise exception 'v1.19.2: missing cs_intake_submissions columns: %', v_missing;
  end if;

  -- Child columns.
  select string_agg(c.tbl || '.' || c.name, ', ')
  into v_missing
  from (values
    ('cs_intake_drivers', 'cdl_years_experience'),
    ('cs_intake_drivers', 'owner_operator'),
    ('cs_intake_drivers', 'accidents_36mo'),
    ('cs_intake_drivers', 'accidents_detail'),
    ('cs_intake_drivers', 'violations_36mo'),
    ('cs_intake_drivers', 'violations_detail'),
    ('cs_intake_vehicles', 'lessor_name'),
    ('cs_intake_vehicles', 'lessor_address'),
    ('cs_intake_commodities', 'percent_hauled'),
    ('cs_intake_commodities', 'average_value'),
    ('cs_intake_commodities', 'maximum_value'),
    ('cs_intake_trailers', 'actual_cash_value')
  ) as c(tbl, name)
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = c.tbl
      and column_name = c.name
  );

  if v_missing is not null then
    raise exception 'v1.19.2: missing child columns: %', v_missing;
  end if;

  -- Exactly one cs_intake_save_draft overload, and it must take 8 arguments.
  select count(*) into v_fn_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'cs_intake_save_draft';

  if v_fn_count <> 1 then
    raise exception 'v1.19.2: expected exactly 1 cs_intake_save_draft overload, found %', v_fn_count;
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cs_intake_save_draft' and p.pronargs = 8
  ) then
    raise exception 'v1.19.2: cs_intake_save_draft does not have the expected 8 parameters';
  end if;

  raise notice 'v1.19.2 applied: trucking underwriting columns, cs_intake_trailers, and the 8-param cs_intake_save_draft are all in place.';
end
$verify$;

commit;
