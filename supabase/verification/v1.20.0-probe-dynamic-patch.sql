-- READ-ONLY IN EFFECT. Exercises the dynamic patch mechanism v1.20.0 introduces
-- against a real intake row and then raises, which rolls the whole DO block back.
-- The findings are carried in the exception message because the Management API does
-- not surface notices.
--
-- Run: node scripts/run-sql.mjs supabase/verification/v1.20.0-probe-dynamic-patch.sql
-- Expect: a failure whose message begins PROBE — that is the success signal.

do $$
declare
  v_id uuid;
  v_before_name text;
  v_before_version integer;
  v_assignments text;
  v_keys text[] := array[
    'auto_liability_limit', 'requested_cargo_limit', 'operation_types',
    'excluded_cargo', 'physical_damage_needed', 'desired_effective_date'
  ];
  v_patch jsonb := jsonb_build_object(
    'auto_liability_limit', '1000000',
    'requested_cargo_limit', 123456,
    'operation_types', jsonb_build_array('trucking', 'hauling'),
    'excluded_cargo', jsonb_build_object('hazardous_materials', 'no'),
    'physical_damage_needed', true,
    'desired_effective_date', '2026-09-01'
  );
  v_after record;
begin
  select id, insured_first_name, version
    into v_id, v_before_name, v_before_version
    from public.cs_intake_submissions
   order by created_at desc
   limit 1;

  if v_id is null then
    raise exception 'PROBE: no cs_intake_submissions rows to test against.';
  end if;

  select string_agg(format('%I = p.%I', k, k), ', ' order by k)
    into v_assignments
    from unnest(v_keys) as k;

  execute format(
    'update public.cs_intake_submissions s
        set %s,
            version = s.version + 1
       from jsonb_populate_record(null::public.cs_intake_submissions, $1) p
      where s.id = $2',
    v_assignments
  ) using v_patch, v_id;

  select auto_liability_limit, requested_cargo_limit, operation_types, excluded_cargo,
         physical_damage_needed, desired_effective_date, insured_first_name, version
    into v_after
    from public.cs_intake_submissions where id = v_id;

  raise exception
    'PROBE OK | assignments=[%] | varchar=% | numeric=% | text[]=% | jsonb=% | bool=% | date=% | untouched_name_matches=% | version %->%',
    v_assignments,
    v_after.auto_liability_limit,
    v_after.requested_cargo_limit,
    v_after.operation_types,
    v_after.excluded_cargo,
    v_after.physical_damage_needed,
    v_after.desired_effective_date,
    (v_after.insured_first_name is not distinct from v_before_name),
    v_before_version,
    v_after.version;
end;
$$;
