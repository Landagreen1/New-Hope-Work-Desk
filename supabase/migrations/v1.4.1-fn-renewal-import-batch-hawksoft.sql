-- v1.4.1 — Patch renewal_import_batch to persist new HawkSoft fields
-- This replaces the UPDATE and INSERT logic to include the new columns added
-- in v1.4.1-renewal-hawksoft-fields.sql.

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
  v_annual numeric;
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
  v_client_since date;
  v_effective_date date;
  v_expiration_date date;
  v_inception_date date;
  v_sold_date date;
begin
  if public.nhwd_role() not in ('manager', 'super_admin') then
    raise exception 'Manager access required.';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Import rows must be a JSON array.';
  end if;

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
    begin
      v_annual := nullif(regexp_replace(coalesce(v_row->>'annual_premium', ''), '[^0-9.\-]', '', 'g'), '')::numeric;
    exception when others then v_annual := null; end;

    -- Parse date fields
    begin v_client_since := nullif(v_row->>'client_since', '')::date;
    exception when others then v_client_since := null; end;
    begin v_effective_date := nullif(v_row->>'effective_date', '')::date;
    exception when others then v_effective_date := null; end;
    begin v_expiration_date := nullif(v_row->>'expiration_date', '')::date;
    exception when others then v_expiration_date := null; end;
    begin v_inception_date := nullif(v_row->>'inception_date', '')::date;
    exception when others then v_inception_date := null; end;
    begin v_sold_date := nullif(v_row->>'sold_date', '')::date;
    exception when others then v_sold_date := null; end;

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

    insert into pg_temp.renewal_import_seen_v0913(policy_number, renewal_date)
    values (v_policy, v_date)
    on conflict do nothing;
    v_file_date_min := least(coalesce(v_file_date_min, v_date), v_date);
    v_file_date_max := greatest(coalesce(v_file_date_max, v_date), v_date);

    if nullif(trim(v_row->>'customer_name'), '') is null then
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
          v_missing_record.id, auth.uid(), 'source_record_restored',
          jsonb_build_object('file_name', p_file_name, 'run_id', v_run_id, 'source_row_incomplete', true)
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
          annual_premium = coalesce(v_annual, record.annual_premium),
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
          -- New HawkSoft fields
          customer_state = coalesce(nullif(trim(v_row->>'customer_state'), ''), record.customer_state),
          customer_zip = coalesce(nullif(trim(v_row->>'customer_zip'), ''), record.customer_zip),
          client_since = coalesce(v_client_since, record.client_since),
          client_office = coalesce(nullif(trim(v_row->>'client_office'), ''), record.client_office),
          client_source = coalesce(nullif(trim(v_row->>'client_source'), ''), record.client_source),
          producer_name = coalesce(nullif(trim(v_row->>'producer_name'), ''), record.producer_name),
          csr_name = coalesce(nullif(trim(v_row->>'csr_name'), ''), record.csr_name),
          policy_status = coalesce(nullif(trim(v_row->>'policy_status'), ''), record.policy_status),
          effective_date = coalesce(v_effective_date, record.effective_date),
          expiration_date = coalesce(v_expiration_date, record.expiration_date),
          inception_date = coalesce(v_inception_date, record.inception_date),
          sold_date = coalesce(v_sold_date, record.sold_date),
          application_type = coalesce(nullif(trim(v_row->>'application_type'), ''), record.application_type),
          policy_office = coalesce(nullif(trim(v_row->>'policy_office'), ''), record.policy_office),
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
      -- INSERT new record
      insert into public.renewal_records(
        status, hawksoft_client_id, policy_number, line_of_business, carrier,
        customer_name, customer_phone, customer_email, renewal_date,
        premium_current, premium_renewal, annual_premium, notice_call_at, import_notes,
        eft_enabled, requote_requested, requote_note, assigned_import_label,
        assigned_to, assigned_at, assignment_source, powerbi_raw,
        last_seen_import_run_id, last_seen_imported_at, source_sync_state,
        missing_since_import_run_id,
        customer_state, customer_zip, client_since, client_office, client_source,
        producer_name, csr_name, policy_status, effective_date, expiration_date,
        inception_date, sold_date, application_type, policy_office
      ) values (
        case when v_assignee_id is not null then 'assigned' else 'imported' end,
        nullif(trim(v_row->>'hawksoft_client_id'), ''), v_policy,
        nullif(trim(v_row->>'line_of_business'), ''), nullif(trim(v_row->>'carrier'), ''),
        trim(v_row->>'customer_name'), nullif(trim(v_row->>'customer_phone'), ''),
        nullif(trim(v_row->>'customer_email'), ''), v_date, v_current, v_renewal,
        v_annual, v_notice_date, nullif(trim(v_row->>'notes'), ''), v_eft, v_requote,
        nullif(trim(v_row->>'requote_note'), ''), v_assigned_label,
        v_assignee_id, case when v_assignee_id is not null then v_imported_at else null end,
        case when v_assignee_id is not null then 'powerbi' else null end,
        coalesce(v_row->'raw', '{}'::jsonb), v_run_id, v_imported_at, 'present', null,
        nullif(trim(v_row->>'customer_state'), ''),
        nullif(trim(v_row->>'customer_zip'), ''),
        v_client_since,
        nullif(trim(v_row->>'client_office'), ''),
        nullif(trim(v_row->>'client_source'), ''),
        nullif(trim(v_row->>'producer_name'), ''),
        nullif(trim(v_row->>'csr_name'), ''),
        nullif(trim(v_row->>'policy_status'), ''),
        v_effective_date, v_expiration_date, v_inception_date, v_sold_date,
        nullif(trim(v_row->>'application_type'), ''),
        nullif(trim(v_row->>'policy_office'), '')
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
    v_run_id, coalesce(nullif(trim(p_file_name), ''), 'hawksoft-renewals.csv'),
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

alter function public.renewal_import_batch(text, jsonb, jsonb) owner to postgres;
