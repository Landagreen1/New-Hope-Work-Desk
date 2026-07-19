-- New Hope Work Desk v0.9.8
-- Stabilized Customer Service Quote Intake + Renewals integration.
-- Compatible with the verified v0.9.5-r3 module baseline and safe to run after
-- a successful v0.9.7.1 installation. Do not run schema.sql or old migrations.
--
-- This migration intentionally recreates RPCs whose return signatures changed,
-- restores every required EXECUTE grant, verifies the database contract, and
-- repairs the daily-reset function without making dashboard loading depend on it.

begin;

-- -----------------------------------------------------------------------------
-- 0. Explicit baseline preflight. Fail early with a useful message.
-- -----------------------------------------------------------------------------
do $preflight$
declare
  v_missing text[] := array[]::text[];
begin
  if to_regclass('public.profiles') is null then v_missing := array_append(v_missing, 'profiles'); end if;
  if to_regclass('public.work_items') is null then v_missing := array_append(v_missing, 'work_items'); end if;
  if to_regclass('public.dealers') is null then v_missing := array_append(v_missing, 'dealers'); end if;
  if to_regclass('public.dealer_salespeople') is null then v_missing := array_append(v_missing, 'dealer_salespeople'); end if;
  if to_regclass('public.user_notifications') is null then v_missing := array_append(v_missing, 'user_notifications'); end if;
  if to_regclass('public.work_item_events') is null then v_missing := array_append(v_missing, 'work_item_events'); end if;
  if to_regclass('public.rotation_state') is null then v_missing := array_append(v_missing, 'rotation_state'); end if;
  if to_regclass('public.availability_day_state') is null then v_missing := array_append(v_missing, 'availability_day_state'); end if;
  if to_regclass('public.cs_intake_submissions') is null then v_missing := array_append(v_missing, 'cs_intake_submissions'); end if;
  if to_regclass('public.cs_intake_drivers') is null then v_missing := array_append(v_missing, 'cs_intake_drivers'); end if;
  if to_regclass('public.cs_intake_vehicles') is null then v_missing := array_append(v_missing, 'cs_intake_vehicles'); end if;
  if to_regclass('public.cs_intake_events') is null then v_missing := array_append(v_missing, 'cs_intake_events'); end if;
  if to_regclass('public.renewal_records') is null then v_missing := array_append(v_missing, 'renewal_records'); end if;
  if to_regclass('public.renewal_contacts') is null then v_missing := array_append(v_missing, 'renewal_contacts'); end if;
  if to_regclass('public.renewal_events') is null then v_missing := array_append(v_missing, 'renewal_events'); end if;
  if to_regprocedure('public.nhwd_role()') is null then v_missing := array_append(v_missing, 'nhwd_role()'); end if;
  if to_regprocedure('public.current_business_date()') is null then v_missing := array_append(v_missing, 'current_business_date()'); end if;

  if cardinality(v_missing) > 0 then
    raise exception 'v0.9.8 baseline is incomplete. Missing: %. Install the verified v0.9.5-r3 module baseline first.', array_to_string(v_missing, ', ');
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- 1. Extend the existing Customer Service intake and renewal records.
-- -----------------------------------------------------------------------------

alter table public.cs_intake_submissions
  add column if not exists quote_kind text not null default 'new_quote',
  add column if not exists source_renewal_id uuid null,
  add column if not exists business_name text null,
  add column if not exists dot_number text null,
  add column if not exists dot_not_applicable boolean not null default false,
  add column if not exists business_type text null,
  add column if not exists years_in_business integer null,
  add column if not exists operating_radius_miles integer null,
  add column if not exists desired_coverage text null,
  add column if not exists liability_limit text null,
  add column if not exists comprehensive_deductible text null,
  add column if not exists collision_deductible text null;

alter table public.cs_intake_drivers
  add column if not exists document_type text not null default 'driver_license';

alter table public.renewal_records
  add column if not exists requote_intake_id uuid null;

alter table public.renewal_contacts
  add column if not exists evidence_path text null,
  add column if not exists evidence_name text null,
  add column if not exists evidence_reference text null,
  add column if not exists evidence_mime_type text null,
  add column if not exists evidence_size_bytes bigint null;

-- Add safe checks only when the named constraint does not already exist.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cs_intake_quote_kind_check') then
    alter table public.cs_intake_submissions
      add constraint cs_intake_quote_kind_check check (quote_kind in ('new_quote', 'requote'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cs_intake_desired_coverage_check') then
    alter table public.cs_intake_submissions
      add constraint cs_intake_desired_coverage_check check (desired_coverage is null or desired_coverage in ('liability_only', 'full_coverage', 'unsure'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cs_intake_driver_document_type_check') then
    alter table public.cs_intake_drivers
      add constraint cs_intake_driver_document_type_check check (document_type in ('driver_license', 'state_id'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cs_intake_source_renewal_fk') then
    alter table public.cs_intake_submissions
      add constraint cs_intake_source_renewal_fk foreign key (source_renewal_id) references public.renewal_records(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'renewal_requote_intake_fk') then
    alter table public.renewal_records
      add constraint renewal_requote_intake_fk foreign key (requote_intake_id) references public.cs_intake_submissions(id) on delete set null;
  end if;
end $$;

create index if not exists cs_intake_source_renewal_idx on public.cs_intake_submissions(source_renewal_id);
create index if not exists renewal_requote_intake_idx on public.renewal_records(requote_intake_id);
create index if not exists renewal_assigned_date_idx on public.renewal_records(assigned_to, renewal_date);
create index if not exists renewal_follow_up_idx on public.renewal_records(next_follow_up_at) where next_follow_up_at is not null;

-- Separate import run history so this patch does not depend on the exact shape of
-- an older renewal_imports table.
create table if not exists public.renewal_import_runs (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  imported_by uuid not null references public.profiles(id),
  column_mapping jsonb not null default '{}'::jsonb,
  rows_total integer not null default 0,
  rows_inserted integer not null default 0,
  rows_updated integer not null default 0,
  rows_skipped integer not null default 0,
  rows_closed_preserved integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.renewal_warning_deliveries (
  id uuid primary key default gen_random_uuid(),
  record_id uuid not null references public.renewal_records(id) on delete cascade,
  recipient_profile_id uuid not null references public.profiles(id) on delete cascade,
  warning_key text not null,
  created_at timestamptz not null default now(),
  unique (record_id, recipient_profile_id, warning_key)
);

alter table public.renewal_import_runs enable row level security;
alter table public.renewal_warning_deliveries enable row level security;

-- -----------------------------------------------------------------------------
-- 2. Storage bucket for renewal contact evidence.
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('renewal-contact-evidence', 'renewal-contact-evidence', false, 15728640)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;

-- -----------------------------------------------------------------------------
-- 3. RLS additions. Existing policies remain; these policies add the new role.
-- -----------------------------------------------------------------------------

drop policy if exists renewal_records_v097_select on public.renewal_records;
create policy renewal_records_v097_select on public.renewal_records
for select to authenticated
using (
  public.nhwd_role() = 'manager'
  or assigned_to = auth.uid()
);

drop policy if exists renewal_records_v097_update on public.renewal_records;
create policy renewal_records_v097_update on public.renewal_records
for update to authenticated
using (
  public.nhwd_role() = 'manager'
  or assigned_to = auth.uid()
)
with check (
  public.nhwd_role() = 'manager'
  or assigned_to = auth.uid()
);

drop policy if exists renewal_contacts_v097_select on public.renewal_contacts;
create policy renewal_contacts_v097_select on public.renewal_contacts
for select to authenticated
using (
  public.nhwd_role() = 'manager'
  or exists (
    select 1 from public.renewal_records r
    where r.id = renewal_contacts.record_id
      and r.assigned_to = auth.uid()
  )
);

drop policy if exists renewal_contacts_v097_insert on public.renewal_contacts;
create policy renewal_contacts_v097_insert on public.renewal_contacts
for insert to authenticated
with check (
  contacted_by = auth.uid()
  and (
    public.nhwd_role() = 'manager'
    or exists (
      select 1 from public.renewal_records r
      where r.id = renewal_contacts.record_id
        and r.assigned_to = auth.uid()
    )
  )
);

drop policy if exists renewal_events_v097_select on public.renewal_events;
create policy renewal_events_v097_select on public.renewal_events
for select to authenticated
using (
  public.nhwd_role() = 'manager'
  or exists (
    select 1 from public.renewal_records r
    where r.id = renewal_events.record_id
      and r.assigned_to = auth.uid()
  )
);

drop policy if exists renewal_import_runs_v097_manager on public.renewal_import_runs;
create policy renewal_import_runs_v097_manager on public.renewal_import_runs
for select to authenticated
using (public.nhwd_role() = 'manager');

drop policy if exists renewal_warning_v097_select on public.renewal_warning_deliveries;
create policy renewal_warning_v097_select on public.renewal_warning_deliveries
for select to authenticated
using (public.nhwd_role() = 'manager' or recipient_profile_id = auth.uid());

-- Storage: all active Work Desk users may upload/read evidence. The renewal RLS
-- still controls whether the related record is visible in the application.
drop policy if exists renewal_evidence_v097_select on storage.objects;
create policy renewal_evidence_v097_select on storage.objects
for select to authenticated
using (
  bucket_id = 'renewal-contact-evidence'
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active)
);

drop policy if exists renewal_evidence_v097_insert on storage.objects;
create policy renewal_evidence_v097_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'renewal-contact-evidence'
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active)
);

drop policy if exists renewal_evidence_v097_delete on storage.objects;
create policy renewal_evidence_v097_delete on storage.objects
for delete to authenticated
using (
  bucket_id = 'renewal-contact-evidence'
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active and p.role::text = 'manager')
);

-- -----------------------------------------------------------------------------
-- 3A. Replace pre-v0.9.7 RPC signatures safely.
-- PostgreSQL cannot CREATE OR REPLACE a function when its RETURNS type changes.
-- These RPCs are application entry points and are recreated later in this same
-- transaction, with EXECUTE grants restored in section 9.
-- -----------------------------------------------------------------------------

drop function if exists public.cs_intake_submit(uuid);
drop function if exists public.cs_intake_convert(uuid);
drop function if exists public.renewal_assign(uuid, uuid);
drop function if exists public.renewal_send_to_requote(uuid);
drop function if exists public.renewal_import_batch(text, jsonb, jsonb);

-- -----------------------------------------------------------------------------
-- 4. Customer Service intake validation, manager assignment, return, conversion.
-- -----------------------------------------------------------------------------

create or replace function public.cs_intake_submit(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cs_intake_submissions%rowtype;
  v_has_salespeople boolean;
begin
  select * into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then raise exception 'Intake not found.'; end if;
  if v_row.created_by <> auth.uid() and public.nhwd_role() <> 'manager' then
    raise exception 'You cannot submit this intake.';
  end if;
  if v_row.status::text not in ('draft', 'returned') then
    raise exception 'Only Draft or Returned intakes can be submitted.';
  end if;

  if nullif(trim(v_row.insured_first_name), '') is null
     or nullif(trim(v_row.insured_last_name), '') is null
     or v_row.insured_dob is null
     or nullif(trim(v_row.insured_phone_primary), '') is null
     or nullif(trim(v_row.addr_street), '') is null
     or nullif(trim(v_row.addr_city), '') is null
     or nullif(trim(v_row.addr_state), '') is null
     or nullif(trim(v_row.addr_zip), '') is null then
    raise exception 'Name, DOB, phone, and full address are required.';
  end if;

  if v_row.desired_coverage is null then
    raise exception 'Choose Liability Only, Full Coverage, or Unsure.';
  end if;

  if v_row.line_of_business::text = 'commercial_auto' then
    if nullif(trim(v_row.business_name), '') is null then raise exception 'Business name is required.'; end if;
    if nullif(trim(v_row.business_type), '') is null then raise exception 'Type of work is required.'; end if;
    if not coalesce(v_row.dot_not_applicable, false) and nullif(trim(v_row.dot_number), '') is null then
      raise exception 'Enter the DOT number or mark DOT not applicable.';
    end if;
  end if;

  if not exists (
    select 1 from public.cs_intake_drivers d
    where d.submission_id = p_submission_id
  ) then raise exception 'Add at least one person or driver.'; end if;

  if exists (
    select 1 from public.cs_intake_drivers d
    where d.submission_id = p_submission_id
      and (
        nullif(trim(d.first_name), '') is null
        or nullif(trim(d.last_name), '') is null
        or d.dob is null
        or nullif(trim(d.license_number), '') is null
        or nullif(trim(d.license_state), '') is null
      )
  ) then raise exception 'Complete the name, DOB, license/ID number, and issuing state for every person.'; end if;

  if not exists (
    select 1 from public.cs_intake_vehicles v
    where v.submission_id = p_submission_id
  ) then raise exception 'Add at least one vehicle.'; end if;

  if exists (
    select 1 from public.cs_intake_vehicles v
    where v.submission_id = p_submission_id
      and (
        v.year is null
        or nullif(trim(v.make), '') is null
        or nullif(trim(v.model), '') is null
        or (nullif(trim(v.vin), '') is null and not coalesce(v.vin_pending, false))
      )
  ) then raise exception 'Complete year, make, model, and VIN (or VIN pending) for every vehicle.'; end if;

  if v_row.dealer_id is not null then
    select exists (
      select 1 from public.dealer_salespeople dsp
      where dsp.dealer_id = v_row.dealer_id and dsp.is_active
    ) into v_has_salespeople;

    if v_has_salespeople and v_row.salesperson_id is null then
      raise exception 'Choose the salesperson for this dealer.';
    end if;
    if v_row.salesperson_id is not null and not exists (
      select 1 from public.dealer_salespeople dsp
      where dsp.id = v_row.salesperson_id
        and dsp.dealer_id = v_row.dealer_id
        and dsp.is_active
    ) then raise exception 'The selected salesperson does not belong to this dealer.'; end if;
  end if;

  update public.cs_intake_submissions
  set status = 'submitted',
      submitted_at = now(),
      return_reason = null,
      updated_at = now()
  where id = p_submission_id;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (p_submission_id, auth.uid(), 'submitted', jsonb_build_object(
    'line_of_business', v_row.line_of_business::text,
    'quote_kind', v_row.quote_kind,
    'priority', v_row.priority::text
  ));

  insert into public.user_notifications (
    recipient_profile_id, notification_type, title, message, entity_type, entity_id
  )
  select p.id, 'assignment', 'New Customer Service quote intake',
         coalesce(nullif(v_row.business_name, ''), trim(v_row.insured_first_name || ' ' || v_row.insured_last_name)) ||
         ' is ready in the Sales Intake Queue.',
         'cs_intake', p_submission_id
  from public.profiles p
  where p.is_active and p.role::text = 'agent';

  if v_row.source_renewal_id is not null then
    update public.renewal_records
    set status = 'requote_sent',
        requote_intake_id = p_submission_id,
        requote_sent_at = now(),
        updated_at = now()
    where id = v_row.source_renewal_id;

    insert into public.renewal_events (record_id, actor_id, event_type, detail)
    values (v_row.source_renewal_id, auth.uid(), 'requote_intake_submitted', jsonb_build_object('intake_id', p_submission_id));
  end if;
end;
$$;

create or replace function public.cs_intake_manager_assign(p_submission_id uuid, p_agent_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creator uuid;
  v_name text;
begin
  if public.nhwd_role() <> 'manager' then raise exception 'Manager access required.'; end if;
  if not exists (select 1 from public.profiles where id = p_agent_id and is_active and role::text = 'agent') then
    raise exception 'Choose an active Sales Agent.';
  end if;

  update public.cs_intake_submissions
  set status = 'claimed', claimed_by = p_agent_id, claimed_at = now(), updated_at = now()
  where id = p_submission_id and status::text = 'submitted'
  returning created_by into v_creator;

  if not found then raise exception 'This intake is no longer available for assignment.'; end if;
  select display_name into v_name from public.profiles where id = p_agent_id;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (p_submission_id, auth.uid(), 'manager_assigned', jsonb_build_object('assigned_to', p_agent_id, 'assigned_name', v_name));

  insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (p_agent_id, 'assignment', 'Quote intake assigned to you', 'A Manager assigned a Customer Service intake. Review it and create the quote.', 'cs_intake', p_submission_id);

  insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (v_creator, 'assignment', 'Your intake was assigned', 'Sales Agent ' || coalesce(v_name, '') || ' received your quote intake.', 'cs_intake', p_submission_id);
end;
$$;

create or replace function public.cs_intake_return(p_submission_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creator uuid;
begin
  if nullif(trim(p_reason), '') is null then raise exception 'A return reason is required.'; end if;

  update public.cs_intake_submissions
  set status = 'returned',
      return_reason = trim(p_reason),
      claimed_by = null,
      claimed_at = null,
      updated_at = now()
  where id = p_submission_id
    and status::text in ('submitted', 'claimed')
    and (public.nhwd_role() = 'manager' or claimed_by = auth.uid() or status::text = 'submitted')
  returning created_by into v_creator;

  if not found then raise exception 'You cannot return this intake.'; end if;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (p_submission_id, auth.uid(), 'returned', jsonb_build_object('reason', trim(p_reason)));

  insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (v_creator, 'assignment', 'Quote intake returned', trim(p_reason), 'cs_intake', p_submission_id);
end;
$$;

create or replace function public.cs_intake_convert(p_submission_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cs_intake_submissions%rowtype;
  v_work_item_id uuid;
  v_existing_quote_id uuid;
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

  -- ─────────────────────────────────────────────────────────────────────────
  -- Idempotency guard: If an operational_quotes record already exists for this
  -- intake (e.g. created by claim_ringcentral_intake), sync cs_intake_submissions
  -- and return the existing quote ID without creating a duplicate work_items record.
  -- This handles the race condition where cs_intake_submissions wasn't synced but
  -- an operational quote already exists. (Req 2.3)
  -- ─────────────────────────────────────────────────────────────────────────
  select id into v_existing_quote_id
  from public.operational_quotes
  where customer_intake_id = p_submission_id
  limit 1;

  if v_existing_quote_id is not null then
    -- Sync cs_intake_submissions to reflect the existing conversion
    update public.cs_intake_submissions
    set status = 'converted',
        work_item_id = v_existing_quote_id,
        converted_at = now(),
        updated_at = now()
    where id = p_submission_id;

    return v_existing_quote_id;
  end if;

  v_customer_name := coalesce(nullif(trim(v_row.business_name), ''), trim(v_row.insured_first_name || ' ' || v_row.insured_last_name));

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
    'insured', jsonb_build_object(
      'first_name', v_row.insured_first_name,
      'last_name', v_row.insured_last_name,
      'dob', v_row.insured_dob,
      'phone', v_row.insured_phone_primary,
      'email', v_row.insured_email,
      'address', concat_ws(', ', v_row.addr_street, v_row.addr_unit, v_row.addr_city, v_row.addr_state, v_row.addr_zip)
    ),
    'drivers', (select coalesce(jsonb_agg(to_jsonb(d) order by d.position), '[]'::jsonb) from public.cs_intake_drivers d where d.submission_id = v_row.id),
    'vehicles', (select coalesce(jsonb_agg(to_jsonb(v) order by v.position), '[]'::jsonb) from public.cs_intake_vehicles v where v.submission_id = v_row.id),
    'current_policy', jsonb_build_object('carrier', v_row.current_carrier, 'policy_number', v_row.current_policy_number, 'premium', v_row.current_premium, 'expiration', v_row.current_expiration),
    'notes', v_row.csr_notes
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

-- -----------------------------------------------------------------------------
-- 5. Renewal contact validation and automatic audit event.
-- -----------------------------------------------------------------------------

create or replace function public.renewal_contact_before_insert_v097()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(new.notes), '') is null then
    raise exception 'Contact notes are required.';
  end if;
  if new.channel::text in ('call', 'sms', 'email')
     and new.evidence_path is null
     and nullif(trim(new.evidence_reference), '') is null
     and new.rc_call_id is null
     and new.rc_recording_content_uri is null then
    raise exception 'Calls, SMS, and email require an attachment or contact/reference record.';
  end if;
  new.contacted_by := coalesce(new.contacted_by, auth.uid());
  new.occurred_at := coalesce(new.occurred_at, now());
  return new;
end;
$$;

create or replace function public.renewal_contact_after_insert_v097()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.renewal_records
  set status = case when status::text in ('imported', 'assigned') then 'in_progress' else status end,
      updated_at = now()
  where id = new.record_id;

  insert into public.renewal_events (record_id, actor_id, event_type, detail)
  values (new.record_id, new.contacted_by, 'contact_logged', jsonb_build_object(
    'contact_id', new.id,
    'channel', new.channel::text,
    'direction', new.direction::text,
    'outcome', new.outcome,
    'evidence_name', new.evidence_name,
    'evidence_reference', new.evidence_reference,
    'entry_source', new.entry_source::text
  ));
  return new;
end;
$$;

drop trigger if exists renewal_contact_before_insert_v097 on public.renewal_contacts;
create trigger renewal_contact_before_insert_v097
before insert on public.renewal_contacts
for each row execute function public.renewal_contact_before_insert_v097();

drop trigger if exists renewal_contact_after_insert_v097 on public.renewal_contacts;
create trigger renewal_contact_after_insert_v097
after insert on public.renewal_contacts
for each row execute function public.renewal_contact_after_insert_v097();

-- -----------------------------------------------------------------------------
-- 6. Renewal workflow, assignment, manager correction, and re-quote intake.
-- -----------------------------------------------------------------------------

create or replace function public.renewal_update_workflow(
  p_record_id uuid,
  p_status text default null,
  p_next_follow_up_at timestamptz default null,
  p_outcome_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.renewal_records%rowtype;
  v_data_type text;
  v_udt_name text;
begin
  select * into v_row from public.renewal_records where id = p_record_id for update;
  if not found then raise exception 'Renewal not found.'; end if;
  if public.nhwd_role() <> 'manager' and v_row.assigned_to <> auth.uid() then raise exception 'This renewal is not assigned to you.'; end if;
  if p_status in ('renewed', 'lost', 'cancelled') and nullif(trim(p_outcome_reason), '') is null then raise exception 'A closing reason or note is required.'; end if;

  if p_status is not null then
    select data_type, udt_name into v_data_type, v_udt_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'renewal_records' and column_name = 'status';

    if v_data_type = 'USER-DEFINED' then
      execute format(
        'update public.renewal_records set status = $1::public.%I, next_follow_up_at = $2, outcome_reason = case when $3 is not null then $3 else outcome_reason end, closed_at = case when $1 in (''renewed'',''lost'',''cancelled'') then now() else null end, updated_at = now() where id = $4',
        v_udt_name
      ) using p_status, p_next_follow_up_at, nullif(trim(p_outcome_reason), ''), p_record_id;
    else
      update public.renewal_records
      set status = p_status,
          next_follow_up_at = p_next_follow_up_at,
          outcome_reason = coalesce(nullif(trim(p_outcome_reason), ''), outcome_reason),
          closed_at = case when p_status in ('renewed', 'lost', 'cancelled') then now() else null end,
          updated_at = now()
      where id = p_record_id;
    end if;
  else
    update public.renewal_records
    set next_follow_up_at = p_next_follow_up_at,
        outcome_reason = coalesce(nullif(trim(p_outcome_reason), ''), outcome_reason),
        updated_at = now()
    where id = p_record_id;
  end if;

  insert into public.renewal_events (record_id, actor_id, event_type, detail)
  values (p_record_id, auth.uid(), 'workflow_updated', jsonb_build_object(
    'status', p_status,
    'next_follow_up_at', p_next_follow_up_at,
    'outcome_reason', p_outcome_reason
  ));
end;
$$;

create or replace function public.renewal_assign(p_record_id uuid, p_agent_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_role text;
begin
  if public.nhwd_role() <> 'manager' then raise exception 'Manager access required.'; end if;

  select display_name, role::text into v_name, v_role
  from public.profiles
  where id = p_agent_id and is_active;

  if not found or v_role not in ('agent', 'customer_service') then
    raise exception 'Choose an active Sales Agent or Customer Service employee.';
  end if;

  update public.renewal_records
  set assigned_to = p_agent_id,
      assigned_at = now(),
      status = case when status::text = 'imported' then 'assigned' else status end,
      updated_at = now()
  where id = p_record_id;

  if not found then raise exception 'Renewal not found.'; end if;

  insert into public.renewal_events (record_id, actor_id, event_type, detail)
  values (p_record_id, auth.uid(), 'assigned', jsonb_build_object('assigned_to', p_agent_id, 'assigned_name', v_name, 'role', v_role));

  insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (p_agent_id, 'assignment', 'Renewal assigned to you', 'A Manager assigned a renewal record. Begin contact within the 30-day window.', 'renewal', p_record_id);
end;
$$;

create or replace function public.renewal_manager_update(p_record_id uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_is_closed boolean;
begin
  if public.nhwd_role() <> 'manager' then raise exception 'Manager access required.'; end if;

  select to_jsonb(r), r.status::text in ('renewed', 'lost', 'cancelled')
  into v_before, v_is_closed
  from public.renewal_records r where r.id = p_record_id for update;

  if v_before is null then raise exception 'Renewal not found.'; end if;

  update public.renewal_records
  set hawksoft_client_id = case when p_patch ? 'hawksoft_client_id' then nullif(p_patch->>'hawksoft_client_id', '') else hawksoft_client_id end,
      policy_number = case when p_patch ? 'policy_number' then coalesce(nullif(p_patch->>'policy_number', ''), policy_number) else policy_number end,
      line_of_business = case when p_patch ? 'line_of_business' then nullif(p_patch->>'line_of_business', '') else line_of_business end,
      carrier = case when p_patch ? 'carrier' then nullif(p_patch->>'carrier', '') else carrier end,
      customer_name = case when p_patch ? 'customer_name' then coalesce(nullif(p_patch->>'customer_name', ''), customer_name) else customer_name end,
      customer_phone = case when p_patch ? 'customer_phone' then nullif(p_patch->>'customer_phone', '') else customer_phone end,
      customer_email = case when p_patch ? 'customer_email' then nullif(p_patch->>'customer_email', '') else customer_email end,
      renewal_date = case when p_patch ? 'renewal_date' then coalesce(nullif(p_patch->>'renewal_date', '')::date, renewal_date) else renewal_date end,
      premium_current = case when p_patch ? 'premium_current' then nullif(p_patch->>'premium_current', '')::numeric else premium_current end,
      premium_renewal = case when p_patch ? 'premium_renewal' then nullif(p_patch->>'premium_renewal', '')::numeric else premium_renewal end,
      dealer_id = case when p_patch ? 'dealer_id' then nullif(p_patch->>'dealer_id', '')::uuid else dealer_id end,
      salesperson_id = case when p_patch ? 'salesperson_id' then nullif(p_patch->>'salesperson_id', '')::uuid else salesperson_id end,
      updated_at = now()
  where id = p_record_id;

  select to_jsonb(r) into v_after from public.renewal_records r where r.id = p_record_id;
  if v_after is distinct from v_before then
    insert into public.renewal_events (record_id, actor_id, event_type, detail)
    values (p_record_id, auth.uid(), 'manager_record_updated', jsonb_build_object('before', v_before, 'after', v_after, 'was_closed', v_is_closed));
  end if;
end;
$$;

create or replace function public.renewal_send_to_requote(p_record_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.renewal_records%rowtype;
  v_intake_id uuid;
  v_first text;
  v_last text;
  v_lob text;
begin
  select * into v_row from public.renewal_records where id = p_record_id for update;
  if not found then raise exception 'Renewal not found.'; end if;
  if public.nhwd_role() <> 'manager' and v_row.assigned_to <> auth.uid() then raise exception 'This renewal is not assigned to you.'; end if;
  if v_row.status::text in ('renewed', 'lost', 'cancelled') then raise exception 'Closed renewals cannot be sent to re-quote.'; end if;
  if v_row.requote_intake_id is not null then return v_row.requote_intake_id; end if;

  v_first := split_part(trim(v_row.customer_name), ' ', 1);
  v_last := nullif(trim(substr(trim(v_row.customer_name), length(v_first) + 1)), '');
  v_lob := case when lower(coalesce(v_row.line_of_business, '')) ~ '(commercial|truck|motor carrier)' then 'commercial_auto' else 'auto' end;

  if v_lob = 'commercial_auto' then
    insert into public.cs_intake_submissions (
      status, priority, line_of_business, quote_kind, source_renewal_id,
      created_by, dealer_id, salesperson_id,
      insured_first_name, insured_last_name, insured_phone_primary, insured_email,
      current_carrier, current_policy_number, current_premium, current_expiration,
      business_name, desired_coverage, csr_notes
    ) values (
      'draft', 'high', 'commercial_auto', 'requote', p_record_id,
      auth.uid(), v_row.dealer_id, v_row.salesperson_id,
      coalesce(v_first, ''), coalesce(v_last, ''), v_row.customer_phone, v_row.customer_email,
      v_row.carrier, v_row.policy_number, coalesce(v_row.premium_renewal, v_row.premium_current), v_row.renewal_date,
      v_row.customer_name, 'unsure',
      'Created from Renewal Management. Complete DOB, address, drivers, vehicles, coverage request, and any missing commercial details before submitting to Sales.'
    ) returning id into v_intake_id;
  else
    insert into public.cs_intake_submissions (
      status, priority, line_of_business, quote_kind, source_renewal_id,
      created_by, dealer_id, salesperson_id,
      insured_first_name, insured_last_name, insured_phone_primary, insured_email,
      current_carrier, current_policy_number, current_premium, current_expiration,
      desired_coverage, csr_notes
    ) values (
      'draft', 'high', 'auto', 'requote', p_record_id,
      auth.uid(), v_row.dealer_id, v_row.salesperson_id,
      coalesce(v_first, ''), coalesce(v_last, ''), v_row.customer_phone, v_row.customer_email,
      v_row.carrier, v_row.policy_number, coalesce(v_row.premium_renewal, v_row.premium_current), v_row.renewal_date,
      'unsure',
      'Created from Renewal Management. Complete DOB, address, drivers, vehicles, and coverage request before submitting to Sales.'
    ) returning id into v_intake_id;
  end if;

  update public.renewal_records
  set requote_intake_id = v_intake_id,
      status = case when status::text = 'imported' then 'monitoring' else status end,
      updated_at = now()
  where id = p_record_id;

  insert into public.renewal_events (record_id, actor_id, event_type, detail)
  values (p_record_id, auth.uid(), 'requote_intake_draft_created', jsonb_build_object('intake_id', v_intake_id));

  return v_intake_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. CSV import/update: update open records, preserve closed records, log changes.
-- -----------------------------------------------------------------------------

create or replace function public.renewal_import_batch(
  p_file_name text,
  p_column_mapping jsonb,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_row jsonb;
  v_existing public.renewal_records%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_total integer := 0;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_closed integer := 0;
  v_policy text;
  v_date date;
  v_current numeric;
  v_renewal numeric;
begin
  if public.nhwd_role() <> 'manager' then raise exception 'Manager access required.'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Import rows must be a JSON array.'; end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_total := v_total + 1;
    v_policy := nullif(trim(v_row->>'policy_number'), '');
    begin v_date := nullif(v_row->>'renewal_date', '')::date; exception when others then v_date := null; end;
    begin v_current := nullif(regexp_replace(coalesce(v_row->>'premium_current', ''), '[^0-9.\-]', '', 'g'), '')::numeric; exception when others then v_current := null; end;
    begin v_renewal := nullif(regexp_replace(coalesce(v_row->>'premium_renewal', ''), '[^0-9.\-]', '', 'g'), '')::numeric; exception when others then v_renewal := null; end;

    if v_policy is null or v_date is null or nullif(trim(v_row->>'customer_name'), '') is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    select * into v_existing
    from public.renewal_records
    where policy_number = v_policy and renewal_date = v_date
    limit 1
    for update;

    if found then
      if v_existing.status::text in ('renewed', 'lost', 'cancelled') then
        v_closed := v_closed + 1;
        continue;
      end if;

      v_before := to_jsonb(v_existing);
      update public.renewal_records
      set customer_name = coalesce(nullif(trim(v_row->>'customer_name'), ''), customer_name),
          customer_phone = coalesce(nullif(trim(v_row->>'customer_phone'), ''), customer_phone),
          customer_email = coalesce(nullif(trim(v_row->>'customer_email'), ''), customer_email),
          carrier = coalesce(nullif(trim(v_row->>'carrier'), ''), carrier),
          line_of_business = coalesce(nullif(trim(v_row->>'line_of_business'), ''), line_of_business),
          hawksoft_client_id = coalesce(nullif(trim(v_row->>'hawksoft_client_id'), ''), hawksoft_client_id),
          premium_current = coalesce(v_current, premium_current),
          premium_renewal = coalesce(v_renewal, premium_renewal),
          updated_at = now()
      where id = v_existing.id;

      select to_jsonb(r) into v_after from public.renewal_records r where r.id = v_existing.id;
      if v_after is distinct from v_before then
        v_updated := v_updated + 1;
        insert into public.renewal_events (record_id, actor_id, event_type, detail)
        values (v_existing.id, auth.uid(), 'import_record_updated', jsonb_build_object('file_name', p_file_name, 'before', v_before, 'after', v_after));
      else
        v_skipped := v_skipped + 1;
      end if;
    else
      insert into public.renewal_records (
        status, hawksoft_client_id, policy_number, line_of_business, carrier,
        customer_name, customer_phone, customer_email, renewal_date,
        premium_current, premium_renewal
      ) values (
        'imported', nullif(trim(v_row->>'hawksoft_client_id'), ''), v_policy,
        nullif(trim(v_row->>'line_of_business'), ''), nullif(trim(v_row->>'carrier'), ''),
        trim(v_row->>'customer_name'), nullif(trim(v_row->>'customer_phone'), ''),
        nullif(trim(v_row->>'customer_email'), ''), v_date, v_current, v_renewal
      ) returning * into v_existing;

      v_inserted := v_inserted + 1;
      insert into public.renewal_events (record_id, actor_id, event_type, detail)
      values (v_existing.id, auth.uid(), 'import_record_created', jsonb_build_object('file_name', p_file_name));
    end if;
  end loop;

  insert into public.renewal_import_runs (
    id, file_name, imported_by, column_mapping, rows_total,
    rows_inserted, rows_updated, rows_skipped, rows_closed_preserved
  ) values (
    v_run_id, coalesce(nullif(trim(p_file_name), ''), 'renewal-import.csv'), auth.uid(), coalesce(p_column_mapping, '{}'::jsonb),
    v_total, v_inserted, v_updated, v_skipped, v_closed
  );

  return jsonb_build_object(
    'id', v_run_id,
    'rows_total', v_total,
    'rows_inserted', v_inserted,
    'rows_updated', v_updated,
    'rows_skipped', v_skipped,
    'rows_closed_preserved', v_closed
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. 30 / 15 / 7 day and overdue notifications.
-- -----------------------------------------------------------------------------

create or replace function public.renewal_generate_due_notifications()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record record;
  v_days integer;
  v_key text;
  v_title text;
  v_count integer := 0;
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active) then
    raise exception 'Active Work Desk user required.';
  end if;

  for v_record in
    select r.id, r.customer_name, r.policy_number, r.renewal_date, r.assigned_to
    from public.renewal_records r
    where r.assigned_to is not null
      and r.status::text in ('imported', 'assigned', 'in_progress', 'monitoring', 'requote_sent')
  loop
    v_days := v_record.renewal_date - current_date;
    v_key := null;
    v_title := null;
    if v_days < 0 then
      v_key := 'overdue-' || current_date::text;
      v_title := 'Overdue renewal follow-up';
    elsif v_days <= 7 then
      v_key := '7';
      v_title := '7-day renewal warning';
    elsif v_days <= 15 then
      v_key := '15';
      v_title := '15-day renewal warning';
    elsif v_days <= 30 then
      v_key := '30';
      v_title := 'Renewal enters 30-day window';
    end if;

    if v_key is not null then
      insert into public.renewal_warning_deliveries (record_id, recipient_profile_id, warning_key)
      values (v_record.id, v_record.assigned_to, v_key)
      on conflict do nothing;

      if found then
        insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
        values (
          v_record.assigned_to, 'assignment', v_title,
          v_record.customer_name || ' · Policy ' || v_record.policy_number || ' · ' ||
          case when v_days < 0 then abs(v_days)::text || ' days overdue' else v_days::text || ' days remaining' end,
          'renewal', v_record.id
        );
        v_count := v_count + 1;
      end if;
    end if;
  end loop;

  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- 9. Daily reset compatibility repair.
--
-- The application no longer calls this maintenance RPC during dashboard load.
-- Existing queue/availability RPCs may still call it internally, so keep it
-- valid, concurrency-safe, and explicitly granted.
-- -----------------------------------------------------------------------------
create or replace function public.ensure_daily_availability_reset()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $daily_reset$
declare
  v_today date := public.current_business_date();
  v_last_business_date date;
begin
  perform pg_advisory_xact_lock(707200072);

  insert into public.availability_day_state(singleton_key, business_date, reset_at)
  values (true, v_today, now())
  on conflict (singleton_key) do nothing;

  select business_date
  into v_last_business_date
  from public.availability_day_state
  where singleton_key = true
  for update;

  if v_last_business_date < v_today then
    update public.profiles
    set availability = 'unavailable'
    where role::text = 'agent'
      and is_active;

    update public.rotation_state
    set current_profile_id = null,
        version = version + 1,
        updated_at = now(),
        updated_by = null
    where kind::text in ('whatsapp', 'ringcentral', 'workload');

    update public.user_notifications
    set read_at = now()
    where notification_type = 'turn'
      and read_at is null;

    update public.availability_day_state
    set business_date = v_today,
        reset_at = now()
    where singleton_key = true;

    return true;
  end if;

  return false;
end;
$daily_reset$;

-- -----------------------------------------------------------------------------
-- 10. Grants and privilege baseline.
-- -----------------------------------------------------------------------------

-- Function permissions belong to the exact function object. Explicitly restore
-- them after every DROP/CREATE cycle and prevent anonymous access.
do $grant_list$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.cs_intake_submit(uuid)',
    'public.cs_intake_claim(uuid)',
    'public.cs_intake_manager_assign(uuid,uuid)',
    'public.cs_intake_return(uuid,text)',
    'public.cs_intake_convert(uuid)',
    'public.renewal_update_workflow(uuid,text,timestamptz,text)',
    'public.renewal_assign(uuid,uuid)',
    'public.renewal_manager_update(uuid,jsonb)',
    'public.renewal_send_to_requote(uuid)',
    'public.renewal_import_batch(text,jsonb,jsonb)',
    'public.renewal_generate_due_notifications()',
    'public.ensure_daily_availability_reset()'
  ]
  loop
    if to_regprocedure(v_signature) is null then
      raise exception 'Required RPC was not created: %', v_signature;
    end if;
    execute format('revoke all privileges on function %s from public', v_signature);
    execute format('revoke all privileges on function %s from anon', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end
$grant_list$;

grant select on public.renewal_import_runs to authenticated, service_role;
grant select on public.renewal_warning_deliveries to authenticated, service_role;

-- Installation contract checks before COMMIT.
do $verify$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.cs_intake_submit(uuid)',
    'public.cs_intake_claim(uuid)',
    'public.cs_intake_manager_assign(uuid,uuid)',
    'public.cs_intake_return(uuid,text)',
    'public.cs_intake_convert(uuid)',
    'public.renewal_update_workflow(uuid,text,timestamptz,text)',
    'public.renewal_assign(uuid,uuid)',
    'public.renewal_manager_update(uuid,jsonb)',
    'public.renewal_send_to_requote(uuid)',
    'public.renewal_import_batch(text,jsonb,jsonb)',
    'public.renewal_generate_due_notifications()',
    'public.ensure_daily_availability_reset()'
  ]
  loop
    if not has_function_privilege('authenticated', v_signature, 'EXECUTE') then
      raise exception 'Authenticated EXECUTE grant missing for %', v_signature;
    end if;
    if has_function_privilege('anon', v_signature, 'EXECUTE') then
      raise exception 'Anonymous role unexpectedly has EXECUTE for %', v_signature;
    end if;
  end loop;

  if not exists (
    select 1 from storage.buckets
    where id = 'renewal-contact-evidence' and public = false
  ) then
    raise exception 'Private renewal evidence bucket was not installed.';
  end if;
end
$verify$;

commit;

select 'New Hope Work Desk v0.9.8 stabilized integrations installed' as status;
