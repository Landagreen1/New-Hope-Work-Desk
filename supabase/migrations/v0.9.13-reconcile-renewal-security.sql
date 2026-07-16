-- New Hope Work Desk v0.9.13
-- Reconcile live renewal import behavior and harden application privileges.
-- This migration is transactional and intentionally does not change realtime publications.

begin;

-- Fail before making changes when the verified application baseline is absent.
do $preflight$
declare
  v_missing text[] := array[]::text[];
  v_relation text;
  v_function text;
begin
  foreach v_relation in array array[
    'public.profiles',
    'public.user_notifications',
    'public.cs_intake_submissions',
    'public.renewal_records',
    'public.renewal_contacts',
    'public.renewal_events',
    'public.renewal_import_runs',
    'public.renewal_warning_deliveries',
    'storage.buckets',
    'storage.objects'
  ] loop
    if to_regclass(v_relation) is null then
      v_missing := array_append(v_missing, v_relation);
    end if;
  end loop;

  foreach v_function in array array[
    'public.nhwd_role()',
    'public.current_business_date()'
  ] loop
    if to_regprocedure(v_function) is null then
      v_missing := array_append(v_missing, v_function);
    end if;
  end loop;

  if cardinality(v_missing) > 0 then
    raise exception
      'v0.9.13 requires the verified Work Desk renewal baseline. Missing: %',
      array_to_string(v_missing, ', ');
  end if;

  if exists (
    select 1
    from (values
      ('profiles', 'id'), ('profiles', 'role'), ('profiles', 'is_active'),
      ('renewal_records', 'id'), ('renewal_records', 'status'),
      ('renewal_records', 'policy_number'), ('renewal_records', 'renewal_date'),
      ('renewal_records', 'customer_name'), ('renewal_records', 'assigned_to'),
      ('renewal_records', 'assigned_at'), ('renewal_records', 'updated_at'),
      ('renewal_contacts', 'record_id'), ('renewal_contacts', 'contacted_by'),
      ('renewal_events', 'record_id'), ('renewal_events', 'actor_id'),
      ('renewal_events', 'event_type'), ('renewal_events', 'detail'),
      ('renewal_import_runs', 'id'), ('renewal_import_runs', 'file_name'),
      ('renewal_import_runs', 'imported_by'), ('renewal_import_runs', 'column_mapping')
    ) as required(table_name, column_name)
    where not exists (
      select 1
      from information_schema.columns columns
      where columns.table_schema = 'public'
        and columns.table_name = required.table_name
        and columns.column_name = required.column_name
    )
  ) then
    raise exception 'v0.9.13 preflight failed: required renewal columns are missing.';
  end if;
end
$preflight$;

-- Reconcile the verified live renewal schema without replacing existing data.
alter table public.renewal_records
  add column if not exists notice_call_at date null,
  add column if not exists import_notes text null,
  add column if not exists eft_enabled boolean null,
  add column if not exists requote_requested boolean not null default false,
  add column if not exists requote_note text null,
  add column if not exists assigned_import_label text null,
  add column if not exists powerbi_raw jsonb not null default '{}'::jsonb,
  add column if not exists assignment_source text null,
  add column if not exists last_seen_import_run_id uuid null,
  add column if not exists last_seen_imported_at timestamptz null,
  add column if not exists source_sync_state text not null default 'present',
  add column if not exists missing_since_import_run_id uuid null;

alter table public.renewal_contacts
  add column if not exists rc_call_id text null,
  add column if not exists rc_session_id text null,
  add column if not exists rc_recording_content_uri text null;

alter table public.renewal_import_runs
  add column if not exists rows_assigned integer not null default 0,
  add column if not exists rows_requote_flagged integer not null default 0,
  add column if not exists unmatched_assignees jsonb not null default '[]'::jsonb,
  add column if not exists rows_missing_in_window integer not null default 0,
  add column if not exists rows_restored_present integer not null default 0,
  add column if not exists distinct_assignee_labels integer not null default 0,
  add column if not exists file_date_min date null,
  add column if not exists file_date_max date null;

create table if not exists public.renewal_assignment_aliases (
  id uuid primary key default gen_random_uuid(),
  import_label text not null,
  normalized_label text not null,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.renewal_assignment_aliases enable row level security;

-- Named constraints are created only when absent on the intended relation.
do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'renewal_assignment_source_check'
      and conrelid = 'public.renewal_records'::regclass
  ) then
    alter table public.renewal_records
      add constraint renewal_assignment_source_check
      check (assignment_source is null or assignment_source in ('powerbi', 'manager', 'manual'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'renewal_source_sync_state_check'
      and conrelid = 'public.renewal_records'::regclass
  ) then
    alter table public.renewal_records
      add constraint renewal_source_sync_state_check
      check (source_sync_state in ('present', 'missing_from_latest_file'));
  end if;
end
$constraints$;

create index if not exists renewal_assignment_aliases_profile_idx
  on public.renewal_assignment_aliases(profile_id);
create unique index if not exists renewal_import_label_idx
  on public.renewal_assignment_aliases(normalized_label);
create index if not exists renewal_import_assignment_label_idx
  on public.renewal_records(lower(assigned_import_label))
  where assigned_import_label is not null;
create index if not exists renewal_last_seen_import_idx
  on public.renewal_records(last_seen_import_run_id)
  where last_seen_import_run_id is not null;
create index if not exists renewal_requote_requested_idx
  on public.renewal_records(renewal_date)
  where requote_requested;
-- Rebuild only a stale same-name index. A prior text-backed deployment may
-- have accepted status::text, while an enum-backed deployment rejects that
-- non-immutable cast in a partial-index predicate.
do $reconcile_sync_exception_index$
declare
  v_definition text;
begin
  select pg_get_indexdef(index_relation.oid)
  into v_definition
  from pg_class index_relation
  join pg_namespace namespace on namespace.oid = index_relation.relnamespace
  where namespace.nspname = 'public'
    and index_relation.relname = 'renewal_sync_exception_idx'
    and index_relation.relkind = 'i';

  if v_definition is not null and (
    position('renewal_date' in lower(v_definition)) = 0
    or position('assigned_to' in lower(v_definition)) = 0
    or position('source_sync_state' in lower(v_definition)) = 0
    or position('missing_from_latest_file' in lower(v_definition)) = 0
    or position('status' in lower(v_definition)) = 0
    or position('imported' in lower(v_definition)) = 0
    or position('''assigned''' in lower(v_definition)) = 0
    or position('in_progress' in lower(v_definition)) = 0
    or position('monitoring' in lower(v_definition)) = 0
    or position('requote_sent' in lower(v_definition)) = 0
    or position('status::text' in lower(v_definition)) > 0
    or position('(status)::text' in lower(v_definition)) > 0
  ) then
    drop index public.renewal_sync_exception_idx;
  end if;
end
$reconcile_sync_exception_index$;

create index if not exists renewal_sync_exception_idx
  on public.renewal_records(renewal_date, assigned_to)
  where source_sync_state = 'missing_from_latest_file'
    and status in ('imported', 'assigned', 'in_progress', 'monitoring', 'requote_sent');
create unique index if not exists renewal_contacts_rc_call_uniq
  on public.renewal_contacts(rc_call_id)
  where rc_call_id is not null;

-- The live function may exist with a different parameter name (e.g. p_value).
-- PostgreSQL requires DROP before CREATE OR REPLACE when renaming parameters.
drop function if exists public.renewal_normalize_assignment_label(text);

create or replace function public.renewal_normalize_assignment_label(p_label text)
returns text
language sql
immutable
strict
set search_path = public, pg_temp
as $function$
  select nullif(
    trim(regexp_replace(lower(trim(p_label)), '[[:space:][:punct:]]+', ' ', 'g')),
    ''
  );
$function$;

create or replace function public.renewal_upsert_assignment_alias(
  p_import_label text,
  p_profile_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_normalized text := public.renewal_normalize_assignment_label(p_import_label);
  v_alias public.renewal_assignment_aliases%rowtype;
  v_record record;
  v_rows_assigned integer := 0;
begin
  if public.nhwd_role() <> 'manager' then
    raise exception 'Manager access required.';
  end if;
  if v_normalized is null then
    raise exception 'An assignment label is required.';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_profile_id
      and profile.is_active
      and profile.role::text in ('agent', 'customer_service')
  ) then
    raise exception 'Choose an active Sales Agent or Customer Service employee.';
  end if;

  insert into public.renewal_assignment_aliases(
    import_label, normalized_label, profile_id
  ) values (
    trim(p_import_label), v_normalized, p_profile_id
  )
  on conflict (normalized_label) do update
  set import_label = excluded.import_label,
      profile_id = excluded.profile_id,
      updated_at = now()
  returning * into v_alias;

  for v_record in
    update public.renewal_records record
    set assigned_to = p_profile_id,
        assigned_at = case
          when record.assigned_to is distinct from p_profile_id then now()
          else record.assigned_at
        end,
        assignment_source = 'powerbi',
        status = case when record.status::text = 'imported' then 'assigned' else record.status end,
        updated_at = now()
    where public.renewal_normalize_assignment_label(record.assigned_import_label) = v_normalized
      and record.status::text in ('imported', 'assigned', 'in_progress', 'monitoring', 'requote_sent')
      and (
        record.assigned_to is null
        or record.assignment_source = 'powerbi'
      )
      and record.assigned_to is distinct from p_profile_id
    returning record.id, record.customer_name, record.renewal_date
  loop
    v_rows_assigned := v_rows_assigned + 1;
    insert into public.renewal_events(record_id, actor_id, event_type, detail)
    values (
      v_record.id,
      auth.uid(),
      'assignment_alias_applied',
      jsonb_build_object('alias_id', v_alias.id, 'profile_id', p_profile_id)
    );
    insert into public.user_notifications(
      recipient_profile_id, notification_type, title, message, entity_type, entity_id
    ) values (
      p_profile_id,
      'assignment',
      'Renewal assigned from import alias',
      v_record.customer_name || ' · renewal ' || to_char(v_record.renewal_date, 'MM/DD/YYYY'),
      'renewal',
      v_record.id
    );
  end loop;

  return jsonb_build_object('alias', to_jsonb(v_alias), 'rows_assigned', v_rows_assigned);
end;
$function$;

create or replace function public.renewal_delete_assignment_alias(p_alias_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if public.nhwd_role() <> 'manager' then
    raise exception 'Manager access required.';
  end if;
  delete from public.renewal_assignment_aliases where id = p_alias_id;
end;
$function$;

-- Manager assignments must carry explicit provenance so a later source import
-- cannot silently replace a manager's decision.
create or replace function public.renewal_assign(p_record_id uuid, p_agent_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_name text;
  v_role text;
begin
  if public.nhwd_role() <> 'manager' then
    raise exception 'Manager access required.';
  end if;

  select profile.display_name, profile.role::text
  into v_name, v_role
  from public.profiles profile
  where profile.id = p_agent_id
    and profile.is_active;

  if not found or v_role not in ('agent', 'customer_service') then
    raise exception 'Choose an active Sales Agent or Customer Service employee.';
  end if;

  update public.renewal_records
  set assigned_to = p_agent_id,
      assigned_at = now(),
      assignment_source = 'manager',
      status = case when status::text = 'imported' then 'assigned' else status end,
      updated_at = now()
  where id = p_record_id;

  if not found then
    raise exception 'Renewal not found.';
  end if;

  insert into public.renewal_events(record_id, actor_id, event_type, detail)
  values (
    p_record_id,
    auth.uid(),
    'assigned',
    jsonb_build_object(
      'assigned_to', p_agent_id,
      'assigned_name', v_name,
      'role', v_role,
      'assignment_source', 'manager'
    )
  );

  insert into public.user_notifications(
    recipient_profile_id, notification_type, title, message, entity_type, entity_id
  ) values (
    p_agent_id,
    'assignment',
    'Renewal assigned to you',
    'A Manager assigned a renewal record. Begin contact within the 30-day window.',
    'renewal',
    p_record_id
  );
end;
$function$;

-- Invalid or malformed object names deny access without attempting a UUID cast.
create or replace function public.can_access_renewal_evidence(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_first_segment text;
  v_record_id uuid;
begin
  if p_object_name is null or p_object_name = '' then
    return false;
  end if;

  v_first_segment := split_part(p_object_name, '/', 1);
  if v_first_segment !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_record_id := v_first_segment::uuid;

  return exists (
    select 1
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.is_active
      and (
        profile.role::text = 'manager'
        or exists (
          select 1
          from public.renewal_records record
          where record.id = v_record_id
            and record.assigned_to = auth.uid()
        )
      )
  );
end;
$function$;

-- Manager-only import. Closed outcomes are never modified. Open records seen in
-- the file are refreshed; absent open records in the file date window are marked
-- as sync exceptions without changing their workflow status.
create or replace function public.renewal_import_batch(
  p_file_name text,
  p_column_mapping jsonb,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_run_id uuid := gen_random_uuid();
  v_imported_at timestamptz := now();
  v_row jsonb;
  v_existing public.renewal_records%rowtype;
  v_record_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_missing_record record;
  v_total integer := 0;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_closed integer := 0;
  v_assigned_count integer := 0;
  v_requote_count integer := 0;
  v_missing_count integer := 0;
  v_restored_count integer := 0;
  v_policy text;
  v_date date;
  v_notice_date date;
  v_current numeric;
  v_renewal numeric;
  v_eft boolean;
  v_requote boolean;
  v_eft_text text;
  v_requote_text text;
  v_assigned_label text;
  v_normalized_label text;
  v_assignee_id uuid;
  v_previous_assignee uuid;
  v_was_missing boolean;
  v_unmatched text[] := array[]::text[];
  v_unmatched_normalized text[] := array[]::text[];
  v_distinct_labels text[] := array[]::text[];
  v_file_date_min date;
  v_file_date_max date;
begin
  if public.nhwd_role() <> 'manager' then
    raise exception 'Manager access required.';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Import rows must be a JSON array.';
  end if;

  -- A file import also computes absence across its date window, so serialize
  -- imports to keep natural-key matching and missing-state diagnostics coherent.
  perform pg_advisory_xact_lock(709130013);

  create temporary table if not exists pg_temp.renewal_import_seen_v0913 (
    policy_number text not null,
    renewal_date date not null,
    primary key(policy_number, renewal_date)
  ) on commit drop;
  truncate table pg_temp.renewal_import_seen_v0913;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_total := v_total + 1;
    v_policy := nullif(trim(v_row->>'policy_number'), '');
    begin v_date := nullif(v_row->>'renewal_date', '')::date;
    exception when others then v_date := null; end;
    begin v_notice_date := nullif(v_row->>'notice_call_date', '')::date;
    exception when others then v_notice_date := null; end;
    begin
      v_current := nullif(regexp_replace(coalesce(v_row->>'premium_current', ''), '[^0-9.\-]', '', 'g'), '')::numeric;
    exception when others then v_current := null; end;
    begin
      v_renewal := nullif(regexp_replace(coalesce(v_row->>'premium_renewal', ''), '[^0-9.\-]', '', 'g'), '')::numeric;
    exception when others then v_renewal := null; end;

    v_eft_text := lower(trim(coalesce(v_row->>'eft', '')));
    v_eft := case
      when v_eft_text = '' then null
      when v_eft_text in ('1', 'true', 'yes', 'y', 'eft', 'active') then true
      when v_eft_text in ('0', 'false', 'no', 'n', 'none', 'inactive') then false
      else null
    end;
    v_requote_text := lower(trim(coalesce(v_row->>'requote', '')));
    v_requote := case
      when v_requote_text = '' then false
      when v_requote_text in ('0', 'false', 'no', 'n', 'none') then false
      else true
    end;

    v_assigned_label := nullif(trim(v_row->>'assigned_name'), '');
    v_normalized_label := public.renewal_normalize_assignment_label(v_assigned_label);
    v_assignee_id := null;

    if v_normalized_label is not null
      and not (v_normalized_label = any(v_distinct_labels)) then
      v_distinct_labels := array_append(v_distinct_labels, v_normalized_label);
    end if;

    if v_normalized_label is not null then
      select profile.id into v_assignee_id
      from public.renewal_assignment_aliases alias
      join public.profiles profile on profile.id = alias.profile_id
      where alias.normalized_label = v_normalized_label
        and profile.is_active
        and profile.role::text in ('agent', 'customer_service')
      limit 1;

      if v_assignee_id is null then
        select profile.id into v_assignee_id
        from public.profiles profile
        where profile.is_active
          and profile.role::text in ('agent', 'customer_service')
          and v_normalized_label in (
            public.renewal_normalize_assignment_label(profile.display_name),
            public.renewal_normalize_assignment_label(profile.username),
            public.renewal_normalize_assignment_label(profile.initials)
          )
        order by case
          when public.renewal_normalize_assignment_label(profile.display_name) = v_normalized_label then 0
          when public.renewal_normalize_assignment_label(profile.username) = v_normalized_label then 1
          else 2
        end, profile.display_name
        limit 1;
      end if;

      if v_assignee_id is null
        and not (v_normalized_label = any(v_unmatched_normalized)) then
        v_unmatched := array_append(v_unmatched, v_assigned_label);
        v_unmatched_normalized := array_append(v_unmatched_normalized, v_normalized_label);
      end if;
    end if;

    if v_policy is null or v_date is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Presence in the source file is independent of whether the row has enough
    -- customer detail to be inserted or updated. Record the natural key first
    -- so an incomplete source row cannot create a false missing transition.
    insert into pg_temp.renewal_import_seen_v0913(policy_number, renewal_date)
    values (v_policy, v_date)
    on conflict do nothing;
    v_file_date_min := least(coalesce(v_file_date_min, v_date), v_date);
    v_file_date_max := greatest(coalesce(v_file_date_max, v_date), v_date);

    if nullif(trim(v_row->>'customer_name'), '') is null then
      -- The source key proves presence even when customer detail is incomplete.
      -- Restore a previously missing open record without overwriting its data.
      for v_missing_record in
        update public.renewal_records record
        set last_seen_import_run_id = v_run_id,
            last_seen_imported_at = v_imported_at,
            source_sync_state = 'present',
            missing_since_import_run_id = null,
            updated_at = v_imported_at
        where record.policy_number = v_policy
          and record.renewal_date = v_date
          and record.status::text in ('imported', 'assigned', 'in_progress', 'monitoring', 'requote_sent')
          and record.source_sync_state = 'missing_from_latest_file'
        returning record.id
      loop
        v_restored_count := v_restored_count + 1;
        insert into public.renewal_events(record_id, actor_id, event_type, detail)
        values (
          v_missing_record.id,
          auth.uid(),
          'source_record_restored',
          jsonb_build_object(
            'file_name', p_file_name,
            'run_id', v_run_id,
            'source_row_incomplete', true
          )
        );
      end loop;

      v_skipped := v_skipped + 1;
      continue;
    end if;

    select * into v_existing
    from public.renewal_records record
    where record.policy_number = v_policy and record.renewal_date = v_date
    order by record.created_at
    limit 1
    for update;

    if found then
      if v_existing.status::text in ('renewed', 'lost', 'cancelled') then
        v_closed := v_closed + 1;
        continue;
      end if;

      -- Preserve every existing owner unless that ownership is explicitly known
      -- to be controlled by the Power BI synchronization.
      if v_existing.assigned_to is not null
        and v_existing.assignment_source is distinct from 'powerbi' then
        v_assignee_id := null;
      end if;

      v_before := to_jsonb(v_existing);
      v_previous_assignee := v_existing.assigned_to;
      v_was_missing := v_existing.source_sync_state = 'missing_from_latest_file';

      update public.renewal_records record
      set customer_name = coalesce(nullif(trim(v_row->>'customer_name'), ''), record.customer_name),
          customer_phone = coalesce(nullif(trim(v_row->>'customer_phone'), ''), record.customer_phone),
          customer_email = coalesce(nullif(trim(v_row->>'customer_email'), ''), record.customer_email),
          carrier = coalesce(nullif(trim(v_row->>'carrier'), ''), record.carrier),
          line_of_business = coalesce(nullif(trim(v_row->>'line_of_business'), ''), record.line_of_business),
          hawksoft_client_id = coalesce(nullif(trim(v_row->>'hawksoft_client_id'), ''), record.hawksoft_client_id),
          premium_current = coalesce(v_current, record.premium_current),
          premium_renewal = coalesce(v_renewal, record.premium_renewal),
          notice_call_at = coalesce(v_notice_date, record.notice_call_at),
          import_notes = coalesce(nullif(trim(v_row->>'notes'), ''), record.import_notes),
          eft_enabled = coalesce(v_eft, record.eft_enabled),
          requote_requested = record.requote_requested or v_requote,
          requote_note = coalesce(nullif(trim(v_row->>'requote_note'), ''), record.requote_note),
          assigned_import_label = coalesce(v_assigned_label, record.assigned_import_label),
          assigned_to = coalesce(v_assignee_id, record.assigned_to),
          assignment_source = case when v_assignee_id is not null then 'powerbi' else record.assignment_source end,
          assigned_at = case
            when v_assignee_id is not null and record.assigned_to is distinct from v_assignee_id then v_imported_at
            else record.assigned_at
          end,
          status = case
            when record.status::text = 'imported' and v_assignee_id is not null then 'assigned'
            else record.status
          end,
          powerbi_raw = coalesce(v_row->'raw', '{}'::jsonb),
          last_seen_import_run_id = v_run_id,
          last_seen_imported_at = v_imported_at,
          source_sync_state = 'present',
          missing_since_import_run_id = null,
          updated_at = v_imported_at
      where record.id = v_existing.id;

      select to_jsonb(record), record.id into v_after, v_record_id
      from public.renewal_records record where record.id = v_existing.id;
      v_updated := v_updated + 1;
      insert into public.renewal_events(record_id, actor_id, event_type, detail)
      values (
        v_record_id, auth.uid(), 'powerbi_record_updated',
        jsonb_build_object('file_name', p_file_name, 'run_id', v_run_id, 'before', v_before, 'after', v_after)
      );

      if v_was_missing then
        v_restored_count := v_restored_count + 1;
        insert into public.renewal_events(record_id, actor_id, event_type, detail)
        values (
          v_record_id, auth.uid(), 'source_record_restored',
          jsonb_build_object('file_name', p_file_name, 'run_id', v_run_id)
        );
      end if;

      if v_assignee_id is not null and v_previous_assignee is distinct from v_assignee_id then
        v_assigned_count := v_assigned_count + 1;
        insert into public.user_notifications(
          recipient_profile_id, notification_type, title, message, entity_type, entity_id
        ) values (
          v_assignee_id, 'assignment', 'Renewal assigned from Power BI',
          coalesce(nullif(trim(v_row->>'customer_name'), ''), v_policy)
            || ' · renewal ' || to_char(v_date, 'MM/DD/YYYY'),
          'renewal', v_record_id
        );
      end if;
    else
      insert into public.renewal_records(
        status, hawksoft_client_id, policy_number, line_of_business, carrier,
        customer_name, customer_phone, customer_email, renewal_date,
        premium_current, premium_renewal, notice_call_at, import_notes,
        eft_enabled, requote_requested, requote_note, assigned_import_label,
        assigned_to, assigned_at, assignment_source, powerbi_raw,
        last_seen_import_run_id, last_seen_imported_at, source_sync_state,
        missing_since_import_run_id
      ) values (
        case when v_assignee_id is not null then 'assigned' else 'imported' end,
        nullif(trim(v_row->>'hawksoft_client_id'), ''), v_policy,
        nullif(trim(v_row->>'line_of_business'), ''), nullif(trim(v_row->>'carrier'), ''),
        trim(v_row->>'customer_name'), nullif(trim(v_row->>'customer_phone'), ''),
        nullif(trim(v_row->>'customer_email'), ''), v_date, v_current, v_renewal,
        v_notice_date, nullif(trim(v_row->>'notes'), ''), v_eft, v_requote,
        nullif(trim(v_row->>'requote_note'), ''), v_assigned_label,
        v_assignee_id, case when v_assignee_id is not null then v_imported_at else null end,
        case when v_assignee_id is not null then 'powerbi' else null end,
        coalesce(v_row->'raw', '{}'::jsonb), v_run_id, v_imported_at, 'present', null
      ) returning id into v_record_id;

      v_inserted := v_inserted + 1;
      insert into public.renewal_events(record_id, actor_id, event_type, detail)
      values (
        v_record_id, auth.uid(), 'powerbi_record_created',
        jsonb_build_object('file_name', p_file_name, 'run_id', v_run_id, 'assigned_import_label', v_assigned_label)
      );

      if v_assignee_id is not null then
        v_assigned_count := v_assigned_count + 1;
        insert into public.user_notifications(
          recipient_profile_id, notification_type, title, message, entity_type, entity_id
        ) values (
          v_assignee_id, 'assignment', 'Renewal assigned from Power BI',
          trim(v_row->>'customer_name') || ' · renewal ' || to_char(v_date, 'MM/DD/YYYY'),
          'renewal', v_record_id
        );
      end if;
    end if;

    if v_requote then v_requote_count := v_requote_count + 1; end if;
  end loop;

  if v_file_date_min is not null and v_file_date_max is not null then
    for v_missing_record in
      update public.renewal_records record
      set source_sync_state = 'missing_from_latest_file',
          missing_since_import_run_id = coalesce(record.missing_since_import_run_id, v_run_id),
          updated_at = v_imported_at
      where record.renewal_date between v_file_date_min and v_file_date_max
        and record.status::text in ('imported', 'assigned', 'in_progress', 'monitoring', 'requote_sent')
        and record.source_sync_state is distinct from 'missing_from_latest_file'
        and not exists (
          select 1 from pg_temp.renewal_import_seen_v0913 seen
          where seen.policy_number = record.policy_number
            and seen.renewal_date = record.renewal_date
        )
      returning record.id
    loop
      v_missing_count := v_missing_count + 1;
      insert into public.renewal_events(record_id, actor_id, event_type, detail)
      values (
        v_missing_record.id, auth.uid(), 'source_record_missing',
        jsonb_build_object(
          'file_name', p_file_name, 'run_id', v_run_id,
          'file_date_min', v_file_date_min, 'file_date_max', v_file_date_max
        )
      );
    end loop;
  end if;

  insert into public.renewal_import_runs(
    id, file_name, imported_by, column_mapping, rows_total, rows_inserted,
    rows_updated, rows_skipped, rows_closed_preserved, rows_assigned,
    rows_requote_flagged, unmatched_assignees, rows_missing_in_window,
    rows_restored_present, distinct_assignee_labels, file_date_min, file_date_max
  ) values (
    v_run_id, coalesce(nullif(trim(p_file_name), ''), 'powerbi-renewals.csv'),
    auth.uid(), coalesce(p_column_mapping, '{}'::jsonb), v_total, v_inserted,
    v_updated, v_skipped, v_closed, v_assigned_count, v_requote_count,
    to_jsonb(v_unmatched), v_missing_count, v_restored_count,
    cardinality(v_distinct_labels), v_file_date_min, v_file_date_max
  );

  return jsonb_build_object(
    'id', v_run_id, 'rows_total', v_total, 'rows_inserted', v_inserted,
    'rows_updated', v_updated, 'rows_skipped', v_skipped,
    'rows_closed_preserved', v_closed, 'rows_assigned', v_assigned_count,
    'rows_requote_flagged', v_requote_count,
    'rows_missing_in_window', v_missing_count,
    'rows_restored_present', v_restored_count,
    'distinct_assignee_labels', cardinality(v_distinct_labels),
    'file_date_min', v_file_date_min, 'file_date_max', v_file_date_max,
    'unmatched_assignees', to_jsonb(v_unmatched)
  );
end;
$function$;

-- Preserve the v0.9.7 renewal visibility contract and remove permissive legacy policies.
-- Policy names are resolved from the catalogs so an older renewal_imports_manager
-- policy is removed even if it was attached to the legacy renewal_imports table.
do $drop_legacy_policies$
declare
  v_policy record;
begin
  for v_policy in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and policyname in (
        'renewal_records_select',
        'renewal_records_update',
        'renewal_contacts_select',
        'renewal_contacts_insert',
        'renewal_events_read',
        'renewal_events_insert',
        'renewal_imports_manager'
      )
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      v_policy.policyname,
      v_policy.schemaname,
      v_policy.tablename
    );
  end loop;
end
$drop_legacy_policies$;

drop policy if exists renewal_records_v097_select on public.renewal_records;
create policy renewal_records_v097_select on public.renewal_records
for select to authenticated
using (public.nhwd_role() = 'manager' or assigned_to = auth.uid());

drop policy if exists renewal_records_v097_update on public.renewal_records;
create policy renewal_records_v097_update on public.renewal_records
for update to authenticated
using (public.nhwd_role() = 'manager' or assigned_to = auth.uid())
with check (public.nhwd_role() = 'manager' or assigned_to = auth.uid());

drop policy if exists renewal_contacts_v097_select on public.renewal_contacts;
create policy renewal_contacts_v097_select on public.renewal_contacts
for select to authenticated
using (
  public.nhwd_role() = 'manager'
  or exists (
    select 1 from public.renewal_records record
    where record.id = renewal_contacts.record_id and record.assigned_to = auth.uid()
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
      select 1 from public.renewal_records record
      where record.id = renewal_contacts.record_id and record.assigned_to = auth.uid()
    )
  )
);

drop policy if exists renewal_events_v097_select on public.renewal_events;
create policy renewal_events_v097_select on public.renewal_events
for select to authenticated
using (
  public.nhwd_role() = 'manager'
  or exists (
    select 1 from public.renewal_records record
    where record.id = renewal_events.record_id and record.assigned_to = auth.uid()
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

drop policy if exists renewal_assignment_aliases_manager_v0911 on public.renewal_assignment_aliases;
create policy renewal_assignment_aliases_manager_v0911 on public.renewal_assignment_aliases
for select to authenticated
using (public.nhwd_role() = 'manager');

-- Keep the evidence bucket private and aligned with the application's 100 MiB limit.
insert into storage.buckets(id, name, public, file_size_limit)
values ('renewal-contact-evidence', 'renewal-contact-evidence', false, 104857600)
on conflict (id) do update
set public = false,
    file_size_limit = 104857600;

drop policy if exists renewal_evidence_v097_select on storage.objects;
drop policy if exists renewal_evidence_v097_insert on storage.objects;
drop policy if exists renewal_evidence_v097_delete on storage.objects;
drop policy if exists renewal_evidence_v09121_select on storage.objects;
create policy renewal_evidence_v09121_select on storage.objects
for select to authenticated
using (
  bucket_id = 'renewal-contact-evidence'
  and public.can_access_renewal_evidence(name)
);
drop policy if exists renewal_evidence_v09121_insert on storage.objects;
create policy renewal_evidence_v09121_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'renewal-contact-evidence'
  and public.can_access_renewal_evidence(name)
);
drop policy if exists renewal_evidence_v09121_delete on storage.objects;
create policy renewal_evidence_v09121_delete on storage.objects
for delete to authenticated
using (
  bucket_id = 'renewal-contact-evidence'
  and public.can_access_renewal_evidence(name)
);

alter table public.renewal_records enable row level security;
alter table public.renewal_contacts enable row level security;
alter table public.renewal_events enable row level security;
alter table public.renewal_import_runs enable row level security;
alter table public.renewal_warning_deliveries enable row level security;

-- The alias list is read directly by the manager UI; mutation remains RPC-only.
grant select on table public.renewal_assignment_aliases to authenticated, service_role;

-- Remove public/anonymous relation access only from the enumerated application
-- relations. Preserve each relation's effective authenticated CRUD privileges as
-- they existed immediately before hardening, while removing elevated privileges.
do $relation_hardening$
declare
  v_name text;
  v_oid regclass;
  v_select boolean;
  v_insert boolean;
  v_update boolean;
  v_delete boolean;
  v_privilege text;
  v_column_privilege record;
begin
  foreach v_name in array array[
    'profiles', 'dealers', 'dealer_salespeople', 'rotation_state',
    'availability_day_state', 'daily_rotation_starts', 'work_items',
    'pending_pricing_quotes', 'quote_outcomes', 'turn_events',
    'quote_take_timers', 'audit_log', 'user_notifications', 'work_item_events',
    'cs_intake_submissions', 'cs_intake_drivers', 'cs_intake_vehicles',
    'cs_intake_events', 'renewal_records', 'renewal_contacts', 'renewal_events',
    'renewal_import_runs', 'renewal_assignment_aliases',
    'renewal_warning_deliveries', 'quote_reporting_feed',
    'pending_pricing_follow_up', 'daily_agent_performance'
  ] loop
    v_oid := to_regclass(format('public.%I', v_name));
    if v_oid is null then
      raise exception 'Required application relation is missing: public.%', v_name;
    end if;

    v_select := has_table_privilege('authenticated', v_oid, 'SELECT');
    v_insert := has_table_privilege('authenticated', v_oid, 'INSERT');
    v_update := has_table_privilege('authenticated', v_oid, 'UPDATE');
    v_delete := has_table_privilege('authenticated', v_oid, 'DELETE');

    execute format('revoke all privileges on table public.%I from public', v_name);
    execute format('revoke all privileges on table public.%I from anon', v_name);

    for v_column_privilege in
      select attribute.attname,
             privilege.privilege_type,
             case
               when privilege.grantee = 0 then 'PUBLIC'
               when privilege.grantee = (select oid from pg_roles where rolname = 'anon') then 'anon'
               else 'authenticated'
             end as grantee_clause
      from pg_attribute attribute
      cross join lateral aclexplode(attribute.attacl) privilege
      where attribute.attrelid = v_oid
        and attribute.attnum > 0
        and not attribute.attisdropped
        and (
          (
            privilege.grantee in (
              0,
              (select oid from pg_roles where rolname = 'anon')
            )
            and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
          )
          or (
            privilege.grantee = (select oid from pg_roles where rolname = 'authenticated')
            and privilege.privilege_type = 'REFERENCES'
          )
        )
    loop
      execute format(
        'revoke %s (%I) on table public.%I from %s',
        v_column_privilege.privilege_type,
        v_column_privilege.attname,
        v_name,
        v_column_privilege.grantee_clause
      );
    end loop;

    for v_privilege in
      select distinct privilege.privilege_type
      from pg_class relation
      cross join lateral aclexplode(
        coalesce(relation.relacl, acldefault('r', relation.relowner))
      ) privilege
      where relation.oid = v_oid
        and privilege.grantee = (select oid from pg_roles where rolname = 'authenticated')
        and privilege.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')
    loop
      execute format('revoke %s on table public.%I from authenticated', v_privilege, v_name);
    end loop;

    if v_select then execute format('grant select on table public.%I to authenticated', v_name); end if;
    if v_insert then execute format('grant insert on table public.%I to authenticated', v_name); end if;
    if v_update then execute format('grant update on table public.%I to authenticated', v_name); end if;
    if v_delete then execute format('grant delete on table public.%I to authenticated', v_name); end if;
  end loop;
end
$relation_hardening$;

-- Harden only explicitly named application functions. Identity signatures from
-- pg_proc make this safe if a current application RPC has overloads.
do $function_hardening$
declare
  v_name text;
  v_proc record;
  v_found boolean;
  v_overload_count integer;
begin
  foreach v_name in array array[
    'complete_password_change', 'ensure_daily_availability_reset',
    'claim_whatsapp_quote', 'claim_ringcentral_quote', 'claim_workload_turn',
    'log_whatsapp_update', 'log_manual_quote', 'pass_my_turn',
    'move_my_quote_to_pending_pricing', 'finalize_my_active_quote',
    'finalize_pending_pricing_quote', 'complete_my_service_item',
    'manager_create_and_assign_quote', 'manager_set_rotation_current',
    'manager_set_rotation_eligibility', 'manager_set_queue_order',
    'manager_reassign_work_item', 'manager_reassign_pending_pricing',
    'start_quote_take_timer_v094', 'send_quote_take_timer_warning',
    'workload_log_list', 'workload_reassign', 'workload_void',
    'admin_deactivate_profile', 'cs_intake_submit', 'cs_intake_claim',
    'cs_intake_manager_assign', 'cs_intake_return', 'cs_intake_convert',
    'renewal_update_workflow', 'renewal_update_contact_info',
    'renewal_manager_update', 'renewal_assign', 'renewal_send_to_requote',
    'renewal_import_batch', 'renewal_generate_due_notifications',
    'renewal_upsert_assignment_alias', 'renewal_delete_assignment_alias',
    'nhwd_role', 'current_business_date', 'renewal_normalize_assignment_label',
    'can_access_renewal_evidence'
  ] loop
    select count(*)
    into v_overload_count
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = v_name;

    if v_overload_count <> 1 then
      raise exception
        'Expected exactly one reviewed signature for public.%, found %',
        v_name,
        v_overload_count;
    end if;

    v_found := false;
    for v_proc in
      select procedure.oid,
             format('%I.%I(%s)', namespace.nspname, procedure.proname,
                    pg_get_function_identity_arguments(procedure.oid)) as signature
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public' and procedure.proname = v_name
    loop
      v_found := true;
      execute format('revoke execute on function %s from public', v_proc.signature);
      execute format('revoke execute on function %s from anon', v_proc.signature);
      execute format('grant execute on function %s to authenticated', v_proc.signature);
      execute format('grant execute on function %s to service_role', v_proc.signature);
    end loop;
    if not v_found then
      raise exception 'Required application function is missing: public.%', v_name;
    end if;
  end loop;

  -- Trigger functions are invoked by PostgreSQL, not directly by browser roles.
  -- Resolve them from the catalogs so older application triggers are hardened too.
  for v_proc in
    select distinct
           procedure.oid,
           format('%I.%I(%s)', namespace.nspname, procedure.proname,
                  pg_get_function_identity_arguments(procedure.oid)) as signature
    from pg_trigger trigger_record
    join pg_class relation on relation.oid = trigger_record.tgrelid
    join pg_namespace relation_namespace on relation_namespace.oid = relation.relnamespace
    join pg_proc procedure on procedure.oid = trigger_record.tgfoid
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where not trigger_record.tgisinternal
      and relation_namespace.nspname = 'public'
      and namespace.nspname = 'public'
  loop
    execute format('revoke execute on function %s from public', v_proc.signature);
    execute format('revoke execute on function %s from anon', v_proc.signature);
    execute format('revoke execute on function %s from authenticated', v_proc.signature);
  end loop;
end
$function_hardening$;

commit;

select 'New Hope Work Desk v0.9.13 renewal reconciliation installed' as status;
