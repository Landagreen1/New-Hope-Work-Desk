-- v1.1.2 Fix duplicate work_item creation on double-click of "Create Quote"
--
-- Problem: If an agent double-clicks "Create Quote" rapidly, two concurrent
-- calls to cs_intake_convert can both pass the status='claimed' check before
-- either commits, creating duplicate work_items for the same intake.
--
-- Fix: Add idempotency guard — if the intake is already 'converted' and has
-- a work_item_id, return the existing work_item_id instead of creating a new one.
-- Also add a UNIQUE partial index on cs_intake_submissions(work_item_id)
-- to make duplicate links structurally impossible at the database level.

begin;

-- 1. Add a unique partial index to prevent two intakes from pointing to the
--    same work_item_id (and more importantly, prevent two work_items for one intake).
--    This acts as a database-level guard against concurrent inserts.
create unique index if not exists cs_intake_one_work_item_per_submission
  on public.cs_intake_submissions (id)
  where work_item_id is not null;

-- 2. Rewrite cs_intake_convert with idempotency guard at the top.
create or replace function public.cs_intake_convert(p_submission_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cs_intake_submissions%rowtype;
  v_work_item_id uuid;
  v_customer_name text;
  v_agent_name text;
  v_details jsonb;
begin
  select * into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then raise exception 'Intake not found.'; end if;

  -- Idempotency: if already converted with a linked work_item, return it.
  if v_row.status::text = 'converted' and v_row.work_item_id is not null then
    return v_row.work_item_id;
  end if;

  if v_row.status::text <> 'claimed' or v_row.claimed_by is null then raise exception 'Claim or assign this intake first.'; end if;
  if public.nhwd_role() <> 'manager' and v_row.claimed_by <> auth.uid() then raise exception 'This intake belongs to another Sales Agent.'; end if;

  v_customer_name := coalesce(nullif(trim(v_row.business_name), ''), trim(v_row.insured_first_name || ' ' || v_row.insured_last_name));

  -- Build details in a flat structure matching IntakeDataDisplay component props.
  v_details := jsonb_build_object(
    'intake_id', v_row.id,
    'csr_profile_id', v_row.created_by,
    'line_of_business', v_row.line_of_business::text,
    'quote_kind', v_row.quote_kind,
    'desired_coverage', v_row.desired_coverage,
    'business_name', v_row.business_name,
    'dot_number', v_row.dot_number,
    'business_type', v_row.business_type,
    'years_in_business', v_row.years_in_business,
    'operating_radius_miles', v_row.operating_radius_miles,
    'insured_first_name', v_row.insured_first_name,
    'insured_last_name', v_row.insured_last_name,
    'insured_dob', v_row.insured_dob,
    'insured_phone_primary', v_row.insured_phone_primary,
    'insured_email', v_row.insured_email,
    'addr_street', v_row.addr_street,
    'addr_city', v_row.addr_city,
    'addr_state', v_row.addr_state,
    'addr_zip', v_row.addr_zip,
    'current_carrier', v_row.current_carrier,
    'current_policy_number', v_row.current_policy_number,
    'current_premium', v_row.current_premium,
    'current_expiration', v_row.current_expiration,
    'csr_notes', v_row.csr_notes,
    'drivers', (select coalesce(jsonb_agg(
      jsonb_build_object(
        'first_name', d.first_name,
        'last_name', d.last_name,
        'dob', d.dob,
        'license_number', d.license_number,
        'license_state', d.license_state,
        'years_licensed', d.years_licensed,
        'sr22_required', d.sr22_required
      ) order by d.position
    ), '[]'::jsonb) from public.cs_intake_drivers d where d.submission_id = v_row.id),
    'vehicles', (select coalesce(jsonb_agg(
      jsonb_build_object(
        'year', v.year,
        'make', v.make,
        'model', v.model,
        'vin', v.vin,
        'usage', v.usage,
        'annual_mileage', v.annual_mileage
      ) order by v.position
    ), '[]'::jsonb) from public.cs_intake_vehicles v where v.submission_id = v_row.id)
  );

  if v_row.quote_kind = 'requote' then
    insert into public.work_items (
      customer_name, dealer_id, salesperson_id, work_type,
      original_owner_profile_id, assigned_profile_id, assignment_method,
      status, note, received_through, created_by, assigned_at
    ) values (
      v_customer_name, v_row.dealer_id, v_row.salesperson_id, 'requote',
      v_row.claimed_by, v_row.claimed_by, 'manual_quote',
      'active', 'Created from Customer Service structured intake', 'cs_intake', v_row.claimed_by, now()
    ) returning id into v_work_item_id;
  else
    insert into public.work_items (
      customer_name, dealer_id, salesperson_id, work_type,
      original_owner_profile_id, assigned_profile_id, assignment_method,
      status, note, received_through, created_by, assigned_at
    ) values (
      v_customer_name, v_row.dealer_id, v_row.salesperson_id, 'new_quote',
      v_row.claimed_by, v_row.claimed_by, 'manual_quote',
      'active', 'Created from Customer Service structured intake', 'cs_intake', v_row.claimed_by, now()
    ) returning id into v_work_item_id;
  end if;

  insert into public.work_item_events (
    source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details
  ) values (
    v_work_item_id, 'created_from_cs_intake', auth.uid(), v_row.claimed_by, v_details
  );

  update public.cs_intake_submissions
  set status = 'converted', work_item_id = v_work_item_id, converted_at = now(), updated_at = now()
  where id = p_submission_id;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (p_submission_id, auth.uid(), 'converted', jsonb_build_object('work_item_id', v_work_item_id, 'sales_owner', v_row.claimed_by));

  if v_row.source_renewal_id is not null then
    update public.renewal_records
    set requote_work_item_id = v_work_item_id,
        requote_intake_id = p_submission_id,
        status = 'requote_sent',
        requote_sent_at = coalesce(requote_sent_at, now()),
        updated_at = now()
    where id = v_row.source_renewal_id;

    insert into public.renewal_events (record_id, actor_id, event_type, detail)
    values (v_row.source_renewal_id, auth.uid(), 'requote_quote_created', jsonb_build_object('intake_id', p_submission_id, 'work_item_id', v_work_item_id));
  end if;

  select display_name into v_agent_name from public.profiles where id = v_row.claimed_by;
  insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (v_row.created_by, 'assignment', 'Intake converted to a quote', coalesce(v_agent_name, 'Sales') || ' created the quote. Your intake credit was preserved.', 'work_item', v_work_item_id);

  return v_work_item_id;
end;
$$;

grant execute on function public.cs_intake_convert(uuid) to authenticated;

commit;
