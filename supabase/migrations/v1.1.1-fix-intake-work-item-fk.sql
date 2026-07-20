-- v1.1.1 Fix cs_intake_submissions -> work_items FK constraint
--
-- Problem: cs_intake_submissions.work_item_id references work_items(id) with
-- the default RESTRICT behavior. When a manager deletes an active quote that
-- originated from a CS intake (via manager_delete_quote), the hard DELETE on
-- work_items fails with:
--   "update or delete on table 'work_items' violates foreign key constraint
--    'cs_intake_submissions_work_item_id_fkey' on table 'cs_intake_submissions'"
--
-- Fix:
--   1. Change the FK to ON DELETE SET NULL so any lifecycle DELETE on work_items
--      automatically clears the reference in cs_intake_submissions.
--   2. Update manager_delete_quote to also reset the intake status back to
--      'claimed' (preserving the agent assignment) so the CS queue reflects
--      that the converted quote was removed.
--   3. Disable RLS on cs_intake_submissions so all authenticated users see all rows.

begin;

-- -----------------------------------------------------------------------------
-- 0. Ensure RLS is disabled on cs_intake_submissions.
--    All agents and managers should see the full historical queue.
-- -----------------------------------------------------------------------------

alter table public.cs_intake_submissions disable row level security;
drop policy if exists "cs_intake_select_all" on public.cs_intake_submissions;
drop policy if exists "cs_intake_insert" on public.cs_intake_submissions;
drop policy if exists "cs_intake_update" on public.cs_intake_submissions;
drop policy if exists "cs_intake_delete" on public.cs_intake_submissions;

-- -----------------------------------------------------------------------------
-- 0b. Add insured_middle_name column for the intake form.
-- -----------------------------------------------------------------------------

alter table public.cs_intake_submissions
  add column if not exists insured_middle_name varchar(75);

-- -----------------------------------------------------------------------------
-- 1. ALTER the FK constraint to ON DELETE SET NULL.
--    This fixes manager_delete_quote AND the quote lifecycle functions
--    (send_quote_to_pending_pricing, finalize_my_active_quote) which also
--    DELETE from work_items when transitioning quotes through the pipeline.
-- -----------------------------------------------------------------------------

alter table public.cs_intake_submissions
  drop constraint if exists cs_intake_submissions_work_item_id_fkey;

alter table public.cs_intake_submissions
  add constraint cs_intake_submissions_work_item_id_fkey
  foreign key (work_item_id) references public.work_items(id) on delete set null;

-- -----------------------------------------------------------------------------
-- 2. Update manager_delete_quote to handle intake-sourced quotes.
--    Before deleting the work_item, reset the linked cs_intake_submissions row
--    so the CS queue shows the intake reverted (no longer "converted").
--    Also notify the original CSR that the quote was removed.
-- -----------------------------------------------------------------------------

create or replace function public.manager_delete_quote(
  p_quote_stage text,
  p_quote_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_source_work_item_id uuid;
  v_reason text := nullif(btrim(p_reason), '');
  v_intake_id uuid;
  v_intake_csr uuid;
begin
  if not public.is_manager() then raise exception 'Manager permission required'; end if;
  if p_quote_id is null then raise exception 'Quote id is required'; end if;
  if v_reason is null then raise exception 'Deletion reason is required'; end if;

  if p_quote_stage = 'active' then
    select to_jsonb(w), w.id into v_old, v_source_work_item_id
    from public.work_items w
    where w.id = p_quote_id and w.work_type in ('new_quote', 'requote')
    for update;
    if v_old is null then raise exception 'Active quote not found'; end if;

    -- Detach any linked CS intake before deleting the work item.
    -- Reset the intake to 'claimed' so it can be re-converted or archived.
    update public.cs_intake_submissions
    set work_item_id = null,
        status = 'claimed',
        converted_at = null,
        updated_at = now()
    where work_item_id = p_quote_id
    returning id, created_by into v_intake_id, v_intake_csr;

    if v_intake_id is not null then
      insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
      values (v_intake_id, auth.uid(), 'quote_deleted_by_manager', jsonb_build_object(
        'work_item_id', p_quote_id,
        'reason', v_reason
      ));

      -- Notify the CSR who created the intake that the quote was removed.
      if v_intake_csr is not null then
        insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
        values (v_intake_csr, 'assignment', 'Linked quote deleted',
          'A manager deleted the quote created from your intake. Reason: ' || v_reason,
          'cs_intake', v_intake_id);
      end if;
    end if;

    delete from public.work_items where id = p_quote_id;

  elsif p_quote_stage = 'pending' then
    select to_jsonb(p), p.source_work_item_id into v_old, v_source_work_item_id
    from public.pending_pricing_quotes p
    where p.id = p_quote_id
    for update;
    if v_old is null then raise exception 'Pending Pricing quote not found'; end if;

    -- Detach any linked CS intake referencing the original work_item_id.
    update public.cs_intake_submissions
    set work_item_id = null,
        status = 'claimed',
        converted_at = null,
        updated_at = now()
    where work_item_id = v_source_work_item_id
    returning id, created_by into v_intake_id, v_intake_csr;

    if v_intake_id is not null then
      insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
      values (v_intake_id, auth.uid(), 'quote_deleted_by_manager', jsonb_build_object(
        'source_work_item_id', v_source_work_item_id,
        'pending_pricing_id', p_quote_id,
        'reason', v_reason
      ));
    end if;

    delete from public.pending_pricing_quotes where id = p_quote_id;

  elsif p_quote_stage = 'finalized' then
    select to_jsonb(q), q.source_work_item_id into v_old, v_source_work_item_id
    from public.quote_outcomes q
    where q.id = p_quote_id
    for update;
    if v_old is null then raise exception 'Finalized quote not found'; end if;
    delete from public.quote_outcomes where id = p_quote_id;
  else
    raise exception 'Invalid quote stage. Expected active, pending, or finalized';
  end if;

  -- Clean up related records (same as v0.8.0 behavior).
  delete from public.quote_notes where source_work_item_id = v_source_work_item_id;
  delete from public.quote_take_events where source_work_item_id = v_source_work_item_id;
  delete from public.work_item_events where source_work_item_id = v_source_work_item_id;

  delete from public.user_notifications
  where entity_id = p_quote_id
     or (v_source_work_item_id is not null and entity_id = v_source_work_item_id);

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, old_value, new_value, reason)
  values (
    auth.uid(),
    'quote_deleted',
    'quote',
    p_quote_id,
    v_old,
    jsonb_build_object('stage', p_quote_stage, 'source_work_item_id', v_source_work_item_id, 'deleted_at', now()),
    v_reason
  );
end;
$$;

-- Ensure grant is in place.
grant execute on function public.manager_delete_quote(text, uuid, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 3. Fix cs_intake_convert to store intake details in a flat shape that the
--    frontend IntakeDataDisplay component can render directly.
--    The old nested format (insured: {first_name, ...}, current_policy: {...})
--    is replaced with top-level keys matching the component's expected interface.
-- -----------------------------------------------------------------------------

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

commit;
