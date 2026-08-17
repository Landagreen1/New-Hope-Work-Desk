-- New Hope Work Desk v1.15.0 — Shared intake drafts, completion attribution,
-- concurrency-safe saves, shared notes, and the stable intake→quote link.
--
-- Forward-only. Additive. No production data is deleted and no historical
-- migration is edited.
--
-- ── Why each piece exists ────────────────────────────────────────────────────
--
-- 1. An unfinished intake is company work, not the private property of whoever
--    answered the phone first. A customer who calls back must be helped by
--    whoever picks up, so `draft` and `returned` intakes become readable and
--    editable by every quote-related role.
--
-- 2. Sharing a draft must not destroy accountability, so three separate facts
--    are now recorded instead of one: who started it (`created_by`, unchanged),
--    who touched it last (`last_edited_by`), and who actually finished and
--    submitted it (`completed_by`). Production credit for a *completed* intake
--    belongs to `completed_by`; `created_by` remains the historical starter.
--
-- 3. Two employees can now hold the same draft open, so saves are guarded by a
--    `version` counter. A stale save is refused rather than silently
--    overwriting the newer information.
--
-- 4. `cs_intake_submissions.work_item_id` is NULL on all 353 live rows and
--    always will be: its foreign key is `on delete set null`, and a quote row
--    is *deleted* from `work_items` when it moves to `pending_pricing_quotes`
--    or `quote_outcomes`. The link therefore needs a column with no foreign
--    key, exactly as `quote_notes.source_work_item_id` and
--    `work_item_events.source_work_item_id` already do. `source_work_item_id`
--    is that column, backfilled from `cs_intake_events.detail->>'work_item_id'`
--    (261 rows), which is where the link has actually been living.
--
-- 5. Google-verified addresses need to record *that they were verified*, not
--    merely that text exists, so the Renters rental-property address can be
--    required to be a real selected place.
--
-- Verified against live Supabase before writing:
--   * public.cs_intake_status has labels draft, submitted, claimed, converted,
--     returned, rejected. There is NO 'deleted' label, so every status test
--     here compares ::text and never casts a literal to the enum.
--   * The live can_read_cs_intake already lets all operational roles read
--     non-draft intakes; it is the live body, not the v1.8.4 repo body, that
--     this migration supersedes.
--   * add_quote_note lives with role in ('agent','manager','customer_service')
--     and no ownership test. Only the role list changes here.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Attribution, concurrency, linkage, and address-verification columns
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.cs_intake_submissions
  -- Who saved changes most recently. Separate from created_by so a shared draft
  -- keeps both facts.
  add column if not exists last_edited_by uuid references public.profiles(id),
  add column if not exists last_edited_at timestamptz,
  -- Who performed the successful final submission. This is the employee who
  -- earns completed-intake production credit.
  add column if not exists completed_by uuid references public.profiles(id),
  -- Optimistic concurrency for shared drafts.
  add column if not exists version integer not null default 1,
  -- The stable quote identity, deliberately WITHOUT a foreign key: the
  -- work_items row is deleted as the quote advances, and this link must survive
  -- that. Mirrors quote_notes.source_work_item_id.
  add column if not exists source_work_item_id uuid,
  -- Customer / mailing address verification state.
  add column if not exists addr_verified boolean not null default false,
  add column if not exists addr_place_id text,
  add column if not exists addr_formatted text,
  -- Rental-property address verification state (Renters).
  add column if not exists renters_addr_verified boolean not null default false,
  add column if not exists renters_place_id text,
  add column if not exists renters_formatted text,
  add column if not exists renters_same_as_customer boolean not null default false;

comment on column public.cs_intake_submissions.created_by is
  'The employee who STARTED the intake. Never rewritten, including when another employee finishes a shared draft.';
comment on column public.cs_intake_submissions.last_edited_by is
  'The employee who saved changes most recently. Null only for rows never edited after creation.';
comment on column public.cs_intake_submissions.completed_by is
  'The employee who performed the successful final submission, and who earns completed-intake production credit. Null on rows submitted before v1.15.0; reporting falls back with coalesce(completed_by, created_by).';
comment on column public.cs_intake_submissions.version is
  'Optimistic-concurrency counter. cs_intake_save_draft refuses a save whose expected version is behind, so a second employee cannot silently overwrite the first.';
comment on column public.cs_intake_submissions.source_work_item_id is
  'The stable quote identity this intake became, with no foreign key on purpose: work_items rows are deleted as a quote moves to pending pricing and then to an outcome. work_item_id cannot serve this role because its on-delete-set-null foreign key has already nulled it on every live row.';
comment on column public.cs_intake_submissions.renters_addr_verified is
  'True only when the rental-property address was selected from Google Places. Editing the text afterwards clears it, so a typed-over address cannot pass as verified.';

-- ── Backfill: the intake→quote link ──────────────────────────────────────────
-- Read from the event detail, which is the only place the link survived.
-- Idempotent: only fills rows that are still null.
update public.cs_intake_submissions s
set source_work_item_id = link.work_item_id
from (
  select
    e.submission_id,
    (e.detail ->> 'work_item_id')::uuid as work_item_id,
    row_number() over (
      partition by e.submission_id
      order by e.created_at desc
    ) as recency
  from public.cs_intake_events e
  where e.event_type = 'converted'
    and e.detail ? 'work_item_id'
    and nullif(e.detail ->> 'work_item_id', '') is not null
) link
where link.submission_id = s.id
  and link.recency = 1
  and s.source_work_item_id is null;

-- ── Backfill: last editor ────────────────────────────────────────────────────
-- Before this migration only the creator could edit their own intake, so the
-- creator is the only employee who can have been the last editor. Recording
-- that is a statement of fact, not a guess.
update public.cs_intake_submissions
set last_edited_by = created_by,
    last_edited_at = updated_at
where last_edited_by is null;

-- completed_by is deliberately NOT backfilled. Guessing it would rewrite
-- historical production totals. Reporting reads coalesce(completed_by,
-- created_by) so pre-v1.15.0 rows keep attributing to the starter, which is how
-- they have always been counted.

create index if not exists cs_intake_source_work_item_idx
  on public.cs_intake_submissions (source_work_item_id)
  where source_work_item_id is not null;

create index if not exists cs_intake_completed_by_idx
  on public.cs_intake_submissions (completed_by, submitted_at desc)
  where completed_by is not null;

-- The enum labels are written directly rather than via `status::text`, because an
-- enum-to-text cast is STABLE and an index predicate must be IMMUTABLE. Both
-- labels were confirmed present in public.cs_intake_status before writing this.
create index if not exists cs_intake_shared_draft_idx
  on public.cs_intake_submissions (updated_at desc)
  where status in ('draft'::public.cs_intake_status, 'returned'::public.cs_intake_status);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. RLS: shared drafts
-- ═══════════════════════════════════════════════════════════════════════════════
-- Read: every quote-related role may FIND any intake at any stage, which is what
-- makes Quote Center able to answer "where is this customer?" from one search.
-- Commercial routing is untouched: commercial roles still see only what they
-- started, because commercial intakes are a separate workflow.

create or replace function public.can_read_cs_intake(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.cs_intake_submissions s
    join public.profiles p on p.id = auth.uid() and p.is_active
    where s.id = p_submission_id
      and (
        public.can_manage_customer_service()
        or public.can_manage_sales()
        -- v1.15.0: quote-related roles read every stage, drafts included, so a
        -- customer who calls back can be found by whoever answers.
        or p.role::text in (
          'agent',
          'customer_service',
          'sales_supervisor',
          'customer_service_supervisor'
        )
        -- Commercial: unchanged. Own records only.
        or (
          p.role::text in ('commercial', 'commercial_supervisor')
          and s.created_by = auth.uid()
        )
      )
  );
$fn$;

-- Edit: the shared-draft grant is added, and every pre-existing grant is kept so
-- nothing that works today stops working. What stops ordinary users rewriting
-- finished history is cs_intake_save_draft below, which refuses to write to a
-- record that already produced a sales quote.
create or replace function public.can_edit_cs_intake(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from public.cs_intake_submissions s
    join public.profiles p on p.id = auth.uid() and p.is_active
    where s.id = p_submission_id
      and (
        public.can_manage_customer_service()
        -- Pre-existing grants, unchanged.
        or (p.role::text = 'customer_service' and s.created_by = auth.uid())
        or (
          p.role::text in ('commercial', 'commercial_supervisor')
          and s.created_by = auth.uid()
        )
        -- v1.15.0: an UNFINISHED intake is shared company work. Only draft and
        -- returned qualify, so this grant can never reach a submitted, claimed
        -- or converted record.
        or (
          p.role::text in (
            'agent',
            'customer_service',
            'sales_supervisor',
            'customer_service_supervisor'
          )
          and s.status::text in ('draft', 'returned')
        )
      )
  );
$fn$;

grant execute on function public.can_read_cs_intake(uuid) to authenticated;
grant execute on function public.can_edit_cs_intake(uuid) to authenticated;

-- Child rows follow the parent, and the events log stays append-only: there is
-- still no update or delete policy on cs_intake_events, by omission.
alter table public.cs_intake_owners enable row level security;
drop policy if exists "Authenticated users can select owners" on public.cs_intake_owners;
drop policy if exists "Authenticated users can insert owners" on public.cs_intake_owners;
drop policy if exists "Authenticated users can update owners" on public.cs_intake_owners;
drop policy if exists "Authenticated users can delete owners" on public.cs_intake_owners;
drop policy if exists "cs_intake_owners_select" on public.cs_intake_owners;
drop policy if exists "cs_intake_owners_insert" on public.cs_intake_owners;
drop policy if exists "cs_intake_owners_update" on public.cs_intake_owners;
drop policy if exists "cs_intake_owners_delete" on public.cs_intake_owners;

-- v1.9.9 claimed to follow the cs_intake_drivers pattern but shipped
-- `using (true)` on all four verbs, so any authenticated user could read or
-- delete business-owner PII. This is the pattern it meant to follow.
create policy "cs_intake_owners_select" on public.cs_intake_owners
  for select to authenticated using (public.can_read_cs_intake(submission_id));
create policy "cs_intake_owners_insert" on public.cs_intake_owners
  for insert to authenticated with check (public.can_edit_cs_intake(submission_id));
create policy "cs_intake_owners_update" on public.cs_intake_owners
  for update to authenticated
  using (public.can_edit_cs_intake(submission_id))
  with check (public.can_edit_cs_intake(submission_id));
create policy "cs_intake_owners_delete" on public.cs_intake_owners
  for delete to authenticated using (public.can_edit_cs_intake(submission_id));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. cs_intake_save_draft — one atomic, version-checked, audited save
-- ═══════════════════════════════════════════════════════════════════════════════
-- Replaces a client-side sequence of five unrelated statements (update parent,
-- delete drivers, insert drivers, delete vehicles, insert vehicles, …) that
-- could half-apply, could not detect a concurrent edit, and recorded no history.
--
-- p_expected_version:
--   null  → the caller is not tracking versions (first save of a fresh record).
--   value → must equal the stored version, or the save is refused.
--
-- Returns the new version so the client can keep saving without a reload.

create or replace function public.cs_intake_save_draft(
  p_submission_id uuid,
  p_payload jsonb,
  p_drivers jsonb default '[]'::jsonb,
  p_vehicles jsonb default '[]'::jsonb,
  p_owners jsonb default '[]'::jsonb,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  -- Columns a user may never set through a draft save. Status transitions,
  -- ownership, attribution, timestamps and the quote link are all owned by
  -- dedicated RPCs.
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

  -- Lock first, so the version test and the write cannot be separated by a
  -- concurrent save.
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

  -- A record that already produced a sales quote is history. Commercial intakes
  -- (which have no sales work item) keep their existing editing behaviour.
  if v_row.source_work_item_id is not null
     and v_row.status::text not in ('draft', 'returned') then
    raise exception 'This intake has already become a quote. Add a note instead of changing the original intake.';
  end if;

  -- Optimistic concurrency. The message names the situation plainly because the
  -- employee needs to know their copy is old, not that something broke.
  if p_expected_version is not null
     and p_expected_version <> v_row.version then
    raise exception
      'This intake was updated by another employee while you were working on it. Review the latest information before saving.'
      using errcode = '40001';
  end if;

  v_old := to_jsonb(v_row);
  v_payload := coalesce(p_payload, '{}'::jsonb) - c_protected;

  -- Legacy label normalisation, matching what the client used to do.
  if v_payload ->> 'line_of_business' = 'personal_auto' then
    v_payload := jsonb_set(v_payload, '{line_of_business}', '"auto"'::jsonb);
  end if;

  -- "Same as Customer Address" is settled server-side so the two addresses can
  -- never drift apart, and so the derived address inherits the customer
  -- address's verification rather than claiming its own.
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

  -- Keep only real columns, and turn an empty string into a JSON null for every
  -- non-text column. A cleared date field arrives from the browser as "", and
  -- ''::date is an error rather than "no date". Text columns are left alone
  -- because several of them are NOT NULL with an empty-string default, and
  -- turning "" into null there would break a partly filled draft.
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

    -- jsonb_populate_record does the type conversion for every column shape in
    -- this table — enums, dates, numerics, jsonb and text[] included — which a
    -- hand-built `(payload ->> key)::type` cast list cannot do correctly for
    -- arrays.
    execute format(
      'update public.cs_intake_submissions s
          set %s
         from jsonb_populate_record(null::public.cs_intake_submissions, $1) as r
        where s.id = $2',
      v_set_list
    ) using v_payload, p_submission_id;
  end if;

  -- Field-level change list for the timeline. Compared as text so a numeric
  -- that arrived as a JSON string is not reported as a change.
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

  -- Children are replaced wholesale, as they always were, but now inside the
  -- same transaction as the parent write, so a save can no longer half-apply.
  --
  -- Columns are listed explicitly rather than expanding a populated record:
  -- these tables have NOT NULL columns with defaults (position, first_name,
  -- sr22_required, incidents, document_type, vin_pending, coverage), and
  -- jsonb_populate_record on a null base would write NULL over each of those
  -- defaults instead of letting them apply.
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

  -- One audit row per save. The timeline reads changed_fields to say what was
  -- added, which is why a mutable notes field could never have served as the
  -- history.
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

revoke execute on function public.cs_intake_save_draft(uuid, jsonb, jsonb, jsonb, jsonb, integer) from public, anon;
grant execute on function public.cs_intake_save_draft(uuid, jsonb, jsonb, jsonb, jsonb, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. cs_intake_submit — completion attribution and the Renters address gate
-- ═══════════════════════════════════════════════════════════════════════════════
-- Body copied from the live definition so nothing else changes. Two additions,
-- both marked v1.15.0:
--   * the successful submission records completed_by and bumps version,
--     atomically, in the same guarded UPDATE that sets the status;
--   * a Renters intake cannot be submitted with an unverified rental address.

create or replace function public.cs_intake_submit(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row public.cs_intake_submissions%rowtype;
  v_has_salespeople boolean;
  v_actor uuid := auth.uid();
begin
  select * into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then raise exception 'Intake not found.'; end if;

  -- v1.15.0: a shared draft may be completed by any quote-related employee, not
  -- only its creator. This is the whole point of sharing drafts.
  if v_row.created_by <> v_actor
     and public.nhwd_role() not in ('manager')
     and not public.can_manage_customer_service()
     and not public.can_manage_sales()
     and not public.can_edit_cs_intake(p_submission_id) then
    raise exception 'You cannot submit this intake.';
  end if;

  if v_row.status::text not in ('draft', 'returned') then
    raise exception 'Only Draft or Returned intakes can be submitted.';
  end if;

  -- This function handles personal-queue LOBs only.
  -- Commercial-routed LOBs (homeowners, trucking, commercial_gl) use cs_intake_submit_commercial.
  if v_row.line_of_business::text not in (
    'auto', 'personal_auto', 'commercial_auto', 'non_owners',
    'motorcycle', 'boat', 'trailer', 'renters'
  ) then
    raise exception 'Use cs_intake_submit_commercial for homeowners, trucking, and commercial GL intakes.';
  end if;

  -- Common validation: name, DOB, phone, address
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

  -- Non-owners: only need SR-22 filing state
  if v_row.line_of_business::text = 'non_owners' then
    if nullif(trim(v_row.sr22_filing_state), '') is null then
      raise exception 'SR-22 filing state is required for Non-Owners.';
    end if;

  -- Motorcycle: basic vehicle info validation
  elsif v_row.line_of_business::text = 'motorcycle' then
    if nullif(trim(v_row.moto_year), '') is null
       or nullif(trim(v_row.moto_make), '') is null
       or nullif(trim(v_row.moto_model), '') is null then
      raise exception 'Motorcycle year, make, and model are required.';
    end if;

  -- Boat: basic vessel info validation
  elsif v_row.line_of_business::text = 'boat' then
    if nullif(trim(v_row.boat_year), '') is null
       or nullif(trim(v_row.boat_make), '') is null
       or nullif(trim(v_row.boat_type), '') is null then
      raise exception 'Boat year, make, and type are required.';
    end if;

  -- Trailer/Mobile Home: basic info validation
  elsif v_row.line_of_business::text = 'trailer' then
    if nullif(trim(v_row.trailer_year), '') is null
       or nullif(trim(v_row.trailer_type), '') is null then
      raise exception 'Trailer year and type are required.';
    end if;

  -- Renters: property address required
  elsif v_row.line_of_business::text = 'renters' then
    if nullif(trim(v_row.renters_property_address), '') is null
       or nullif(trim(v_row.renters_city), '') is null
       or nullif(trim(v_row.renters_state), '') is null
       or nullif(trim(v_row.renters_zip), '') is null then
      raise exception 'Rental property address (street, city, state, zip) is required.';
    end if;

    -- v1.15.0: the rental property is the insured risk, so its address has to be
    -- a place Google actually returned, not free text that happens to look like
    -- an address. "Same as Customer Address" satisfies this by inheriting the
    -- customer address's own verification.
    if not coalesce(v_row.renters_addr_verified, false) then
      raise exception 'Choose the rental property address from the address suggestions so it can be verified.';
    end if;

  -- Auto types need coverage selection, drivers, vehicles
  else
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
  end if;

  -- Dealer/salesperson validation (applies to all personal-queue LOBs)
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
      where dsp.id = v_row.salesperson_id and dsp.dealer_id = v_row.dealer_id and dsp.is_active
    ) then
      raise exception 'Invalid salesperson for this dealer.';
    end if;
  end if;

  -- v1.15.0: status, submission timestamp, completing employee and version all
  -- move in one guarded UPDATE. The status predicate is what makes a double
  -- submission — a double-click or a browser retry — fail closed instead of
  -- awarding completion credit twice.
  update public.cs_intake_submissions
  set status = 'submitted',
      submitted_at = now(),
      completed_by = v_actor,
      last_edited_by = v_actor,
      last_edited_at = now(),
      version = version + 1,
      updated_at = now()
  where id = p_submission_id
    and status::text in ('draft', 'returned');

  if not found then
    raise exception 'This intake was already submitted.';
  end if;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (p_submission_id, v_actor, 'submitted', jsonb_build_object(
    'line_of_business', v_row.line_of_business::text,
    'quote_kind', v_row.quote_kind,
    'priority', v_row.priority::text,
    -- Both facts, permanently, on the submission event itself.
    'started_by', v_row.created_by,
    'completed_by', v_actor,
    'completed_by_starter', (v_row.created_by = v_actor)
  ));

  -- Notify all active sales agents
  insert into public.user_notifications (
    recipient_profile_id, notification_type, title, message, entity_type, entity_id
  )
  select p.id, 'assignment', 'New Customer Service quote intake',
         coalesce(nullif(v_row.business_name, ''), trim(v_row.insured_first_name || ' ' || v_row.insured_last_name)) ||
         ' is ready in the Sales Intake Queue.',
         'cs_intake', p_submission_id
  from public.profiles p
  where p.is_active and p.role::text = 'agent';

  -- v1.15.0: when someone else finished the draft, tell the employee who
  -- started it. Their contribution stays visible and they are not left
  -- wondering where the intake went.
  if v_row.created_by is distinct from v_actor then
    insert into public.user_notifications (
      recipient_profile_id, notification_type, title, message, entity_type, entity_id
    )
    select v_row.created_by, 'assignment', 'Your intake draft was completed',
           coalesce(p.display_name, 'A teammate')
             || ' finished and submitted the intake you started. You remain recorded as the employee who started it.',
           'cs_intake', p_submission_id
    from public.profiles p
    where p.id = v_actor;
  end if;

  if v_row.source_renewal_id is not null then
    update public.renewal_records
    set status = 'requote_sent',
        requote_intake_id = p_submission_id,
        requote_sent_at = now(),
        updated_at = now()
    where id = v_row.source_renewal_id;

    insert into public.renewal_events (record_id, actor_id, event_type, detail)
    values (v_row.source_renewal_id, v_actor, 'requote_intake_submitted', jsonb_build_object('intake_id', p_submission_id));
  end if;
end;
$fn$;

grant execute on function public.cs_intake_submit(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. cs_intake_convert — record the stable quote link
-- ═══════════════════════════════════════════════════════════════════════════════
-- Body copied from the live definition. The single change is that the final
-- UPDATE now also writes source_work_item_id, so the link survives the
-- work_items row being deleted later in the quote's life. work_item_id keeps
-- being written too, unchanged, so nothing that reads it changes behaviour.

create or replace function public.cs_intake_convert(p_submission_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
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
  -- v1.15.0: source_work_item_id is checked too, because work_item_id is nulled
  -- by its own foreign key once the quote advances past active.
  if v_row.status::text = 'converted'
     and coalesce(v_row.work_item_id, v_row.source_work_item_id) is not null then
    return coalesce(v_row.work_item_id, v_row.source_work_item_id);
  end if;

  if v_row.status::text <> 'claimed' or v_row.claimed_by is null then
    raise exception 'Claim or assign this intake first.';
  end if;

  -- Allow: managers, super_admins, sales_supervisors, or the agent who claimed it
  if not public.can_manage_sales() and v_row.claimed_by <> auth.uid() then
    raise exception 'This intake belongs to another Sales Agent.';
  end if;

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
    'insured_dob', case
      when v_row.insured_dob is not null then
        to_char(v_row.insured_dob, 'FMMM/FMDD/YYYY')
      else null
    end,
    'insured_phone_primary', v_row.insured_phone_primary,
    'insured_email', v_row.insured_email,
    'addr_street', v_row.addr_street,
    'addr_unit', v_row.addr_unit,
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
        'dob', case
          when d.dob is not null then to_char(d.dob, 'FMMM/FMDD/YYYY')
          else null
        end,
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
  set status = 'converted',
      work_item_id = v_work_item_id,
      -- v1.15.0: the durable link.
      source_work_item_id = v_work_item_id,
      converted_at = now(),
      updated_at = now()
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
$fn$;

grant execute on function public.cs_intake_convert(uuid) to authenticated;

commit;
