-- New Hope Work Desk v0.9.9
-- Unified role workspaces + Power BI renewal import support.
--
-- Compatible with the verified v0.9.8 stabilized integration.
-- Run this file once in Supabase SQL Editor. Do not rerun schema.sql.

begin;

do $preflight$
declare
  v_missing text[] := array[]::text[];
begin
  if to_regclass('public.profiles') is null then v_missing := array_append(v_missing, 'profiles'); end if;
  if to_regclass('public.renewal_records') is null then v_missing := array_append(v_missing, 'renewal_records'); end if;
  if to_regclass('public.renewal_events') is null then v_missing := array_append(v_missing, 'renewal_events'); end if;
  if to_regclass('public.renewal_import_runs') is null then v_missing := array_append(v_missing, 'renewal_import_runs'); end if;
  if to_regclass('public.user_notifications') is null then v_missing := array_append(v_missing, 'user_notifications'); end if;
  if to_regprocedure('public.nhwd_role()') is null then v_missing := array_append(v_missing, 'nhwd_role()'); end if;

  if to_regprocedure('public.renewal_import_batch(text,jsonb,jsonb)') is null then
    v_missing := array_append(v_missing, 'renewal_import_batch(text,jsonb,jsonb)');
  end if;

  if exists (
    select 1
    from (values
      ('renewal_records', 'id'),
      ('renewal_records', 'status'),
      ('renewal_records', 'policy_number'),
      ('renewal_records', 'renewal_date'),
      ('renewal_records', 'customer_name'),
      ('renewal_records', 'customer_phone'),
      ('renewal_records', 'customer_email'),
      ('renewal_records', 'carrier'),
      ('renewal_records', 'line_of_business'),
      ('renewal_records', 'hawksoft_client_id'),
      ('renewal_records', 'premium_current'),
      ('renewal_records', 'premium_renewal'),
      ('renewal_records', 'assigned_to'),
      ('renewal_records', 'assigned_at'),
      ('renewal_records', 'updated_at'),
      ('renewal_events', 'record_id'),
      ('renewal_events', 'actor_id'),
      ('renewal_events', 'event_type'),
      ('renewal_events', 'detail'),
      ('renewal_import_runs', 'id'),
      ('renewal_import_runs', 'file_name'),
      ('renewal_import_runs', 'imported_by'),
      ('renewal_import_runs', 'column_mapping'),
      ('profiles', 'username'),
      ('profiles', 'display_name'),
      ('profiles', 'initials'),
      ('profiles', 'role'),
      ('profiles', 'is_active'),
      ('user_notifications', 'recipient_profile_id'),
      ('user_notifications', 'notification_type'),
      ('user_notifications', 'title'),
      ('user_notifications', 'message'),
      ('user_notifications', 'entity_type'),
      ('user_notifications', 'entity_id')
    ) as required(table_name, column_name)
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = required.table_name
        and c.column_name = required.column_name
    )
  ) then
    raise exception
      'v0.9.9 preflight failed: the live database is missing one or more required v0.9.8 columns. Run v0.9.8 health verification before this migration.';
  end if;

  if cardinality(v_missing) > 0 then
    raise exception
      'v0.9.9 requires the v0.9.8 baseline. Missing: %',
      array_to_string(v_missing, ', ');
  end if;
end
$preflight$;

alter table public.renewal_records
  add column if not exists notice_call_at date null,
  add column if not exists import_notes text null,
  add column if not exists eft_enabled boolean null,
  add column if not exists requote_requested boolean not null default false,
  add column if not exists requote_note text null,
  add column if not exists assigned_import_label text null,
  add column if not exists powerbi_raw jsonb not null default '{}'::jsonb;

alter table public.renewal_import_runs
  add column if not exists rows_assigned integer not null default 0,
  add column if not exists rows_requote_flagged integer not null default 0,
  add column if not exists unmatched_assignees jsonb not null default '[]'::jsonb;

create index if not exists renewal_requote_requested_idx
  on public.renewal_records (renewal_date)
  where requote_requested;

create index if not exists renewal_import_assignment_label_idx
  on public.renewal_records (lower(assigned_import_label))
  where assigned_import_label is not null;

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
  v_row jsonb;
  v_existing public.renewal_records%rowtype;
  v_record_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_total integer := 0;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_skipped integer := 0;
  v_closed integer := 0;
  v_assigned_count integer := 0;
  v_requote_count integer := 0;
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
  v_assignee_id uuid;
  v_previous_assignee uuid;
  v_unmatched text[] := array[]::text[];
begin
  if public.nhwd_role() <> 'manager' then
    raise exception 'Manager access required.';
  end if;

  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Import rows must be a JSON array.';
  end if;

  for v_row in
    select value from jsonb_array_elements(p_rows)
  loop
    v_total := v_total + 1;
    v_policy := nullif(trim(v_row->>'policy_number'), '');

    begin
      v_date := nullif(v_row->>'renewal_date', '')::date;
    exception when others then
      v_date := null;
    end;

    begin
      v_notice_date := nullif(v_row->>'notice_call_date', '')::date;
    exception when others then
      v_notice_date := null;
    end;

    begin
      v_current := nullif(
        regexp_replace(coalesce(v_row->>'premium_current', ''), '[^0-9.\-]', '', 'g'),
        ''
      )::numeric;
    exception when others then
      v_current := null;
    end;

    begin
      v_renewal := nullif(
        regexp_replace(coalesce(v_row->>'premium_renewal', ''), '[^0-9.\-]', '', 'g'),
        ''
      )::numeric;
    exception when others then
      v_renewal := null;
    end;

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
    v_assignee_id := null;

    if v_assigned_label is not null then
      select p.id
      into v_assignee_id
      from public.profiles p
      where p.is_active
        and p.role::text in ('agent', 'customer_service')
        and (
          lower(trim(p.display_name)) = lower(v_assigned_label)
          or lower(trim(coalesce(p.username, ''))) = lower(v_assigned_label)
          or lower(trim(coalesce(p.initials, ''))) = lower(v_assigned_label)
          or lower(trim(p.display_name)) like lower(v_assigned_label) || ' %'
        )
      order by
        case
          when lower(trim(p.display_name)) = lower(v_assigned_label) then 0
          when lower(trim(coalesce(p.username, ''))) = lower(v_assigned_label) then 1
          when lower(trim(coalesce(p.initials, ''))) = lower(v_assigned_label) then 2
          else 3
        end,
        p.display_name
      limit 1;

      if v_assignee_id is null
        and not exists (
          select 1
          from unnest(v_unmatched) as unmatched_item
          where lower(unmatched_item) = lower(v_assigned_label)
        )
      then
        v_unmatched := array_append(v_unmatched, v_assigned_label);
      end if;
    end if;

    if v_policy is null
      or v_date is null
      or nullif(trim(v_row->>'customer_name'), '') is null
    then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    select *
    into v_existing
    from public.renewal_records
    where policy_number = v_policy
      and renewal_date = v_date
    limit 1
    for update;

    if found then
      if v_existing.status::text in ('renewed', 'lost', 'cancelled') then
        v_closed := v_closed + 1;
        continue;
      end if;

      v_before := to_jsonb(v_existing);
      v_previous_assignee := v_existing.assigned_to;

      update public.renewal_records
      set customer_name = coalesce(
            nullif(trim(v_row->>'customer_name'), ''),
            customer_name
          ),
          customer_phone = coalesce(
            nullif(trim(v_row->>'customer_phone'), ''),
            customer_phone
          ),
          customer_email = coalesce(
            nullif(trim(v_row->>'customer_email'), ''),
            customer_email
          ),
          carrier = coalesce(
            nullif(trim(v_row->>'carrier'), ''),
            carrier
          ),
          line_of_business = coalesce(
            nullif(trim(v_row->>'line_of_business'), ''),
            line_of_business
          ),
          hawksoft_client_id = coalesce(
            nullif(trim(v_row->>'hawksoft_client_id'), ''),
            hawksoft_client_id
          ),
          premium_current = coalesce(v_current, premium_current),
          premium_renewal = coalesce(v_renewal, premium_renewal),
          notice_call_at = coalesce(v_notice_date, notice_call_at),
          import_notes = coalesce(
            nullif(trim(v_row->>'notes'), ''),
            import_notes
          ),
          eft_enabled = coalesce(v_eft, eft_enabled),
          requote_requested = requote_requested or v_requote,
          requote_note = coalesce(
            nullif(trim(v_row->>'requote_note'), ''),
            requote_note
          ),
          assigned_import_label = coalesce(
            v_assigned_label,
            assigned_import_label
          ),
          assigned_to = coalesce(v_assignee_id, assigned_to),
          status = case
            when status::text = 'imported' and v_assignee_id is not null
            then 'assigned'
            else status
          end,
          assigned_at = case
            when v_assignee_id is not null
              and assigned_to is distinct from v_assignee_id
            then now()
            else assigned_at
          end,
          powerbi_raw = coalesce(v_row->'raw', '{}'::jsonb),
          updated_at = now()
      where id = v_existing.id;

      select to_jsonb(r), r.id
      into v_after, v_record_id
      from public.renewal_records r
      where r.id = v_existing.id;

      if v_after is distinct from v_before then
        v_updated := v_updated + 1;

        insert into public.renewal_events (
          record_id,
          actor_id,
          event_type,
          detail
        )
        values (
          v_existing.id,
          auth.uid(),
          'powerbi_record_updated',
          jsonb_build_object(
            'file_name', p_file_name,
            'before', v_before,
            'after', v_after
          )
        );
      else
        v_skipped := v_skipped + 1;
      end if;

      if v_assignee_id is not null
        and v_previous_assignee is distinct from v_assignee_id
      then
        v_assigned_count := v_assigned_count + 1;

        insert into public.user_notifications (
          recipient_profile_id,
          notification_type,
          title,
          message,
          entity_type,
          entity_id
        )
        values (
          v_assignee_id,
          'assignment',
          'Renewal assigned from Power BI',
          coalesce(nullif(trim(v_row->>'customer_name'), ''), v_policy)
            || ' · renewal '
            || to_char(v_date, 'MM/DD/YYYY'),
          'renewal',
          v_existing.id
        );
      end if;
    else
      insert into public.renewal_records (
        status,
        hawksoft_client_id,
        policy_number,
        line_of_business,
        carrier,
        customer_name,
        customer_phone,
        customer_email,
        renewal_date,
        premium_current,
        premium_renewal,
        notice_call_at,
        import_notes,
        eft_enabled,
        requote_requested,
        requote_note,
        assigned_import_label,
        assigned_to,
        assigned_at,
        powerbi_raw
      )
      values (
        case when v_assignee_id is not null then 'assigned' else 'imported' end,
        nullif(trim(v_row->>'hawksoft_client_id'), ''),
        v_policy,
        nullif(trim(v_row->>'line_of_business'), ''),
        nullif(trim(v_row->>'carrier'), ''),
        trim(v_row->>'customer_name'),
        nullif(trim(v_row->>'customer_phone'), ''),
        nullif(trim(v_row->>'customer_email'), ''),
        v_date,
        v_current,
        v_renewal,
        v_notice_date,
        nullif(trim(v_row->>'notes'), ''),
        v_eft,
        v_requote,
        nullif(trim(v_row->>'requote_note'), ''),
        v_assigned_label,
        v_assignee_id,
        case when v_assignee_id is not null then now() else null end,
        coalesce(v_row->'raw', '{}'::jsonb)
      )
      returning id into v_record_id;

      v_inserted := v_inserted + 1;

      insert into public.renewal_events (
        record_id,
        actor_id,
        event_type,
        detail
      )
      values (
        v_record_id,
        auth.uid(),
        'powerbi_record_created',
        jsonb_build_object(
          'file_name', p_file_name,
          'assigned_import_label', v_assigned_label
        )
      );

      if v_assignee_id is not null then
        v_assigned_count := v_assigned_count + 1;

        insert into public.user_notifications (
          recipient_profile_id,
          notification_type,
          title,
          message,
          entity_type,
          entity_id
        )
        values (
          v_assignee_id,
          'assignment',
          'Renewal assigned from Power BI',
          trim(v_row->>'customer_name')
            || ' · renewal '
            || to_char(v_date, 'MM/DD/YYYY'),
          'renewal',
          v_record_id
        );
      end if;
    end if;

    if v_requote then
      v_requote_count := v_requote_count + 1;
    end if;
  end loop;

  insert into public.renewal_import_runs (
    id,
    file_name,
    imported_by,
    column_mapping,
    rows_total,
    rows_inserted,
    rows_updated,
    rows_skipped,
    rows_closed_preserved,
    rows_assigned,
    rows_requote_flagged,
    unmatched_assignees
  )
  values (
    v_run_id,
    coalesce(nullif(trim(p_file_name), ''), 'powerbi-renewals.csv'),
    auth.uid(),
    coalesce(p_column_mapping, '{}'::jsonb),
    v_total,
    v_inserted,
    v_updated,
    v_skipped,
    v_closed,
    v_assigned_count,
    v_requote_count,
    to_jsonb(v_unmatched)
  );

  return jsonb_build_object(
    'id', v_run_id,
    'rows_total', v_total,
    'rows_inserted', v_inserted,
    'rows_updated', v_updated,
    'rows_skipped', v_skipped,
    'rows_closed_preserved', v_closed,
    'rows_assigned', v_assigned_count,
    'rows_requote_flagged', v_requote_count,
    'unmatched_assignees', to_jsonb(v_unmatched)
  );
end;
$function$;

alter function public.renewal_import_batch(text, jsonb, jsonb)
  owner to postgres;

revoke all privileges
  on function public.renewal_import_batch(text, jsonb, jsonb)
  from public;

revoke all privileges
  on function public.renewal_import_batch(text, jsonb, jsonb)
  from anon;

grant execute
  on function public.renewal_import_batch(text, jsonb, jsonb)
  to authenticated, service_role;

comment on function public.renewal_import_batch(text, jsonb, jsonb) is
  'Manager-only Power BI/HawkSoft renewal import. Matches open records by policy number + renewal date, preserves closed records, logs changes, maps ASIGNADO to active Sales/Customer Service profiles, and returns import diagnostics.';

do $verify$
begin
  if not has_function_privilege(
    'authenticated',
    'public.renewal_import_batch(text,jsonb,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'v0.9.9 failed: authenticated cannot execute renewal_import_batch';
  end if;

  if has_function_privilege(
    'anon',
    'public.renewal_import_batch(text,jsonb,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'v0.9.9 failed: anon unexpectedly has access to renewal_import_batch';
  end if;
end
$verify$;

commit;

select 'New Hope Work Desk v0.9.9 unified workspaces and Power BI import installed' as status;
