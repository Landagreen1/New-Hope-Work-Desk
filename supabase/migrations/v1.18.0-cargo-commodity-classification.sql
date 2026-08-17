-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.18.0 — Cargo / Commodity Classification for Trucking Intakes
--
-- Replaces the single free-text `cargo_type` (varchar 100) with a structured
-- commodity system. The old column remains for backward compatibility but new
-- intakes write to the expanded columns and child table.
--
-- Changes:
--   1. New columns on cs_intake_submissions for cargo underwriting fields
--   2. New child table cs_intake_commodities for multi-select categories
--   3. Extend cs_intake_save_draft to accept p_commodities parameter
--   4. RLS policies on the child table
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. NEW COLUMNS on cs_intake_submissions for structured cargo data
-- ═══════════════════════════════════════════════════════════════════════════════

-- Primary commodity (the single biggest portion of operations)
alter table public.cs_intake_submissions
  add column if not exists primary_commodity varchar(100);

-- Free-text operations/cargo description
alter table public.cs_intake_submissions
  add column if not exists cargo_description text;

-- Broker / load board usage
alter table public.cs_intake_submissions
  add column if not exists broker_load_board boolean;

-- Whether the commodity mix is fully known
alter table public.cs_intake_submissions
  add column if not exists commodity_mix_known boolean;

-- Cargo value fields
alter table public.cs_intake_submissions
  add column if not exists typical_load_value numeric(12,2);

alter table public.cs_intake_submissions
  add column if not exists max_load_value numeric(12,2);

alter table public.cs_intake_submissions
  add column if not exists requested_cargo_limit numeric(12,2);

alter table public.cs_intake_submissions
  add column if not exists cargo_deductible numeric(12,2);

-- Refrigerated cargo
alter table public.cs_intake_submissions
  add column if not exists refrigerated boolean;

alter table public.cs_intake_submissions
  add column if not exists temperature_controlled_equipment boolean;

alter table public.cs_intake_submissions
  add column if not exists reefer_breakdown_requested varchar(20);

-- Hazmat
alter table public.cs_intake_submissions
  add column if not exists hazmat varchar(20);

-- High-value cargo flag (computed from selections but stored for query)
alter table public.cs_intake_submissions
  add column if not exists high_value_cargo_flag boolean default false;

-- Auto hauling specifics
alter table public.cs_intake_submissions
  add column if not exists auto_hauling_vehicles_per_load integer;

alter table public.cs_intake_submissions
  add column if not exists auto_hauling_max_value numeric(12,2);

-- Machinery specifics
alter table public.cs_intake_submissions
  add column if not exists machinery_max_value numeric(12,2);

-- Excluded / prohibited cargo quick-answers (jsonb for flexible yes/no/unsure map)
alter table public.cs_intake_submissions
  add column if not exists excluded_cargo jsonb;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. CHILD TABLE — cs_intake_commodities
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.cs_intake_commodities (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.cs_intake_submissions(id) on delete cascade,
  category varchar(80) not null,
  frequency varchar(20) default 'mostly',
  is_primary boolean default false,
  created_at timestamptz default now(),

  constraint cs_intake_commodities_frequency_check
    check (frequency in ('mostly', 'sometimes', 'occasionally'))
);

create index if not exists idx_cs_intake_commodities_submission
  on public.cs_intake_commodities(submission_id);

-- Only one primary per submission
create unique index if not exists idx_cs_intake_commodities_primary
  on public.cs_intake_commodities(submission_id)
  where is_primary = true;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. RLS POLICIES on cs_intake_commodities
--    Mirror the parent table's policies: authenticated users can read all,
--    insert/update/delete gated by can_edit_cs_intake on the parent row.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.cs_intake_commodities enable row level security;

create policy "cs_intake_commodities_select"
  on public.cs_intake_commodities for select
  to authenticated
  using (true);

create policy "cs_intake_commodities_insert"
  on public.cs_intake_commodities for insert
  to authenticated
  with check (
    public.can_edit_cs_intake(submission_id)
  );

create policy "cs_intake_commodities_update"
  on public.cs_intake_commodities for update
  to authenticated
  using (
    public.can_edit_cs_intake(submission_id)
  );

create policy "cs_intake_commodities_delete"
  on public.cs_intake_commodities for delete
  to authenticated
  using (
    public.can_edit_cs_intake(submission_id)
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. EXTEND cs_intake_save_draft to accept p_commodities
--
--    The function signature changes from 6 params to 7. We replace in place.
--    The grant must be re-issued for the new signature.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop old signature to avoid overload ambiguity
drop function if exists public.cs_intake_save_draft(uuid, jsonb, jsonb, jsonb, jsonb, integer);

create or replace function public.cs_intake_save_draft(
  p_submission_id uuid,
  p_payload jsonb,
  p_drivers jsonb default '[]'::jsonb,
  p_vehicles jsonb default '[]'::jsonb,
  p_owners jsonb default '[]'::jsonb,
  p_commodities jsonb default '[]'::jsonb,
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

  select * into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Intake not found.';
  end if;

  if not public.can_edit_cs_intake(p_submission_id) then
    raise exception 'You cannot edit this intake.';
  end if;

  if v_row.source_work_item_id is not null
     and v_row.status::text not in ('draft', 'returned') then
    raise exception 'This intake has already become a quote. Add a note instead of changing the original intake.';
  end if;

  if p_expected_version is not null
     and p_expected_version <> v_row.version then
    raise exception
      'This intake was updated by another employee while you were working on it. Review the latest information before saving.'
      using errcode = '40001';
  end if;

  v_old := to_jsonb(v_row);
  v_payload := coalesce(p_payload, '{}'::jsonb) - c_protected;

  if v_payload ->> 'line_of_business' = 'personal_auto' then
    v_payload := jsonb_set(v_payload, '{line_of_business}', '"auto"'::jsonb);
  end if;

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
      years_licensed, sr22_required, incidents
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
      coalesce(item.value -> 'incidents', '[]'::jsonb)
    from jsonb_array_elements(p_drivers) with ordinality as item(value, ordinality);
  end if;

  -- ─── Children: vehicles ─────────────────────────────────────────────────────
  delete from public.cs_intake_vehicles where submission_id = p_submission_id;
  if jsonb_typeof(coalesce(p_vehicles, '[]'::jsonb)) = 'array'
     and jsonb_array_length(coalesce(p_vehicles, '[]'::jsonb)) > 0 then
    insert into public.cs_intake_vehicles (
      submission_id, position, year, make, model, vin, vin_pending,
      ownership, lienholder, usage, annual_mileage, garaging_zip, coverage
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
      coalesce(item.value -> 'coverage', '{}'::jsonb)
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

  -- ─── Children: commodities (NEW) ───────────────────────────────────────────
  delete from public.cs_intake_commodities where submission_id = p_submission_id;
  if jsonb_typeof(coalesce(p_commodities, '[]'::jsonb)) = 'array'
     and jsonb_array_length(coalesce(p_commodities, '[]'::jsonb)) > 0 then
    insert into public.cs_intake_commodities (
      submission_id, category, frequency, is_primary
    )
    select
      p_submission_id,
      coalesce(item.value ->> 'category', ''),
      coalesce(nullif(item.value ->> 'frequency', ''), 'mostly'),
      coalesce(nullif(item.value ->> 'is_primary', '')::boolean, false)
    from jsonb_array_elements(p_commodities) as item(value)
    where coalesce(item.value ->> 'category', '') <> '';
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

revoke execute on function public.cs_intake_save_draft(uuid, jsonb, jsonb, jsonb, jsonb, jsonb, integer) from public, anon;
grant execute on function public.cs_intake_save_draft(uuid, jsonb, jsonb, jsonb, jsonb, jsonb, integer) to authenticated;

commit;
