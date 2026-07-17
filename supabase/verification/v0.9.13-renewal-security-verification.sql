-- New Hope Work Desk v0.9.13 renewal security verification
-- Read-only metadata checks only. This query does not read application/customer rows.
-- Every failed check remains visible in the single result set.

with
app_relations(relation_name) as (
  values
    ('profiles'), ('dealers'), ('dealer_salespeople'), ('rotation_state'),
    ('availability_day_state'), ('daily_rotation_starts'), ('work_items'),
    ('pending_pricing_quotes'), ('quote_outcomes'), ('turn_events'),
    ('quote_take_timers'), ('audit_log'), ('user_notifications'),
    ('work_item_events'), ('cs_intake_submissions'), ('cs_intake_drivers'),
    ('cs_intake_vehicles'), ('cs_intake_events'), ('renewal_records'),
    ('renewal_contacts'), ('renewal_events'), ('renewal_import_runs'),
    ('renewal_assignment_aliases'), ('renewal_warning_deliveries'),
    ('quote_reporting_feed'), ('pending_pricing_follow_up'),
    ('daily_agent_performance')
),
app_functions(function_name) as (
  values
    ('complete_password_change'), ('ensure_daily_availability_reset'),
    ('claim_whatsapp_quote'), ('claim_ringcentral_quote'), ('claim_workload_turn'),
    ('log_whatsapp_update'), ('log_manual_quote'), ('pass_my_turn'),
    ('move_my_quote_to_pending_pricing'), ('finalize_my_active_quote'),
    ('finalize_pending_pricing_quote'), ('complete_my_service_item'),
    ('manager_create_and_assign_quote'), ('manager_set_rotation_current'),
    ('manager_set_rotation_eligibility'), ('manager_set_queue_order'),
    ('manager_reassign_work_item'), ('manager_reassign_pending_pricing'),
    ('start_quote_take_timer_v094'), ('send_quote_take_timer_warning'),
    ('workload_log_list'), ('workload_reassign'), ('workload_void'),
    ('admin_deactivate_profile'), ('cs_intake_submit'), ('cs_intake_claim'),
    ('cs_intake_manager_assign'), ('cs_intake_return'), ('cs_intake_convert'),
    ('renewal_update_workflow'), ('renewal_update_contact_info'),
    ('renewal_manager_update'), ('renewal_assign'), ('renewal_send_to_requote'),
    ('renewal_import_batch'), ('renewal_generate_due_notifications'),
    ('renewal_upsert_assignment_alias'), ('renewal_delete_assignment_alias'),
    ('nhwd_role'), ('current_business_date'),
    ('renewal_normalize_assignment_label'), ('can_access_renewal_evidence')
),
required_relations(relation_name) as (
  values
    ('renewal_records'), ('renewal_contacts'), ('renewal_events'),
    ('renewal_import_runs'), ('renewal_assignment_aliases'),
    ('renewal_warning_deliveries')
),
required_columns(table_name, column_name, expected_udt) as (
  values
    ('renewal_records', 'notice_call_at', 'date'),
    ('renewal_records', 'import_notes', 'text'),
    ('renewal_records', 'eft_enabled', 'bool'),
    ('renewal_records', 'requote_requested', 'bool'),
    ('renewal_records', 'requote_note', 'text'),
    ('renewal_records', 'assigned_import_label', 'text'),
    ('renewal_records', 'powerbi_raw', 'jsonb'),
    ('renewal_records', 'assignment_source', 'text'),
    ('renewal_records', 'last_seen_import_run_id', 'uuid'),
    ('renewal_records', 'last_seen_imported_at', 'timestamptz'),
    ('renewal_records', 'source_sync_state', 'text'),
    ('renewal_records', 'missing_since_import_run_id', 'uuid'),
    ('renewal_contacts', 'rc_call_id', 'text'),
    ('renewal_contacts', 'rc_session_id', 'text'),
    ('renewal_contacts', 'rc_recording_content_uri', 'text'),
    ('renewal_import_runs', 'rows_assigned', 'int4'),
    ('renewal_import_runs', 'rows_requote_flagged', 'int4'),
    ('renewal_import_runs', 'unmatched_assignees', 'jsonb'),
    ('renewal_import_runs', 'rows_missing_in_window', 'int4'),
    ('renewal_import_runs', 'rows_restored_present', 'int4'),
    ('renewal_import_runs', 'distinct_assignee_labels', 'int4'),
    ('renewal_import_runs', 'file_date_min', 'date'),
    ('renewal_import_runs', 'file_date_max', 'date')
),
required_constraints(constraint_name, relation_name, expected_tokens) as (
  values
    ('renewal_assignment_source_check', 'renewal_records',
      array['assignment_source', 'powerbi', 'manager', 'manual']::text[]),
    ('renewal_source_sync_state_check', 'renewal_records',
      array['source_sync_state', 'present', 'missing_from_latest_file']::text[])
),
required_indexes(index_name, relation_name, expected_unique, expected_tokens) as (
  values
    ('renewal_assignment_aliases_profile_idx', 'renewal_assignment_aliases', false,
      array['profile_id']::text[]),
    ('renewal_import_assignment_label_idx', 'renewal_records', false,
      array['lower', 'assigned_import_label']::text[]),
    ('renewal_import_label_idx', 'renewal_assignment_aliases', true,
      array['normalized_label']::text[]),
    ('renewal_last_seen_import_idx', 'renewal_records', false,
      array['last_seen_import_run_id']::text[]),
    ('renewal_requote_requested_idx', 'renewal_records', false,
      array['renewal_date', 'requote_requested']::text[]),
    ('renewal_sync_exception_idx', 'renewal_records', false,
      array[
        'renewal_date', 'assigned_to', 'source_sync_state',
        'missing_from_latest_file', 'status', 'imported', '''assigned''',
        'in_progress', 'monitoring', 'requote_sent'
      ]::text[]),
    ('renewal_contacts_rc_call_uniq', 'renewal_contacts', true,
      array['rc_call_id']::text[])
),
required_function_signatures(signature, expected_security_definer) as (
  values
    ('public.renewal_normalize_assignment_label(text)', false),
    ('public.renewal_upsert_assignment_alias(text,uuid)', true),
    ('public.renewal_delete_assignment_alias(uuid)', true),
    ('public.renewal_assign(uuid,uuid)', true),
    ('public.renewal_import_batch(text,jsonb,jsonb)', true),
    ('public.can_access_renewal_evidence(text)', true)
),
legacy_policies(schema_name, table_name, policy_name) as (
  values
    ('public', 'renewal_records', 'renewal_records_select'),
    ('public', 'renewal_records', 'renewal_records_update'),
    ('public', 'renewal_contacts', 'renewal_contacts_select'),
    ('public', 'renewal_contacts', 'renewal_contacts_insert'),
    ('public', 'renewal_events', 'renewal_events_read'),
    ('public', 'renewal_events', 'renewal_events_insert'),
    ('public', null::text, 'renewal_imports_manager'),
    ('storage', 'objects', 'renewal_evidence_v097_select'),
    ('storage', 'objects', 'renewal_evidence_v097_insert'),
    ('storage', 'objects', 'renewal_evidence_v097_delete')
),
required_policies(schema_name, table_name, policy_name, command_name, expression_tokens) as (
  values
    ('public', 'renewal_records', 'renewal_records_v097_select', 'SELECT',
      array['nhwd_role', 'manager', 'assigned_to', 'auth.uid']::text[]),
    ('public', 'renewal_records', 'renewal_records_v097_update', 'UPDATE',
      array['nhwd_role', 'manager', 'assigned_to', 'auth.uid']::text[]),
    ('public', 'renewal_contacts', 'renewal_contacts_v097_select', 'SELECT',
      array['nhwd_role', 'renewal_records', 'assigned_to', 'auth.uid']::text[]),
    ('public', 'renewal_contacts', 'renewal_contacts_v097_insert', 'INSERT',
      array['contacted_by', 'auth.uid', 'renewal_records', 'assigned_to']::text[]),
    ('public', 'renewal_events', 'renewal_events_v097_select', 'SELECT',
      array['nhwd_role', 'renewal_records', 'assigned_to', 'auth.uid']::text[]),
    ('public', 'renewal_import_runs', 'renewal_import_runs_v097_manager', 'SELECT',
      array['nhwd_role', 'manager']::text[]),
    ('public', 'renewal_warning_deliveries', 'renewal_warning_v097_select', 'SELECT',
      array['nhwd_role', 'recipient_profile_id', 'auth.uid']::text[]),
    ('public', 'renewal_assignment_aliases', 'renewal_assignment_aliases_manager_v0911', 'SELECT',
      array['nhwd_role', 'manager']::text[]),
    ('storage', 'objects', 'renewal_evidence_v09121_select', 'SELECT',
      array['renewal-contact-evidence', 'can_access_renewal_evidence', 'name']::text[]),
    ('storage', 'objects', 'renewal_evidence_v09121_insert', 'INSERT',
      array['renewal-contact-evidence', 'can_access_renewal_evidence', 'name']::text[]),
    ('storage', 'objects', 'renewal_evidence_v09121_delete', 'DELETE',
      array['renewal-contact-evidence', 'can_access_renewal_evidence', 'name']::text[])
),
expected_realtime(relation_name) as (
  values
    ('dealers'), ('profiles'), ('rotation_state'), ('work_items'),
    ('pending_pricing_quotes'), ('quote_outcomes'), ('turn_events'),
    ('user_notifications'), ('work_item_events')
),
checks(check_name, pass, expected, actual) as (
  select
    'relation.' || required.relation_name,
    class.oid is not null,
    'present'::text,
    coalesce(format('%s (%s)', class.relname, class.relkind), 'missing')
  from required_relations required
  left join pg_class class
    on class.relnamespace = 'public'::regnamespace
   and class.relname = required.relation_name
   and class.relkind in ('r', 'p')

  union all

  select
    'column.' || required.table_name || '.' || required.column_name,
    columns.column_name is not null and columns.udt_name = required.expected_udt,
    'present with type ' || required.expected_udt,
    coalesce(columns.udt_name, 'missing')
  from required_columns required
  left join information_schema.columns columns
    on columns.table_schema = 'public'
   and columns.table_name = required.table_name
   and columns.column_name = required.column_name

  union all

  select
    'constraint.' || required.constraint_name,
    constraint_record.oid is not null
      and constraint_record.convalidated
      and not exists (
        select 1 from unnest(required.expected_tokens) token
        where position(lower(token) in lower(pg_get_constraintdef(constraint_record.oid, true))) = 0
      ),
    'present, validated, definition contains ' || array_to_string(required.expected_tokens, ', '),
    coalesce(
      jsonb_build_object(
        'validated', constraint_record.convalidated,
        'definition', pg_get_constraintdef(constraint_record.oid, true)
      )::text,
      'missing'
    )
  from required_constraints required
  left join pg_constraint constraint_record
    on constraint_record.conname = required.constraint_name
   and constraint_record.conrelid = to_regclass('public.' || required.relation_name)

  union all

  select
    'index.' || required.index_name,
    index_relation.oid is not null
      and coalesce(index_record.indisvalid, false)
      and coalesce(index_record.indisready, false)
      and index_record.indrelid = to_regclass('public.' || required.relation_name)
      and index_record.indisunique = required.expected_unique
      and not exists (
        select 1 from unnest(required.expected_tokens) token
        where position(lower(token) in lower(pg_get_indexdef(index_relation.oid))) = 0
      ),
    format(
      'present on public.%s; valid; ready; unique=%s; definition contains %s',
      required.relation_name,
      required.expected_unique,
      array_to_string(required.expected_tokens, ', ')
    ),
    case when index_relation.oid is null then 'missing' else
      jsonb_build_object(
        'relation', index_record.indrelid::regclass::text,
        'unique', index_record.indisunique,
        'valid', index_record.indisvalid,
        'ready', index_record.indisready,
        'definition', pg_get_indexdef(index_relation.oid)
      )::text
    end
  from required_indexes required
  left join pg_class index_relation
    on index_relation.relnamespace = 'public'::regnamespace
   and index_relation.relname = required.index_name
   and index_relation.relkind = 'i'
  left join pg_index index_record on index_record.indexrelid = index_relation.oid

  union all

  select
    'function.' || required.signature,
    procedure.oid is not null
      and procedure.prosecdef = required.expected_security_definer
      and (
        not required.expected_security_definer
        or (
          position('search_path=public' in coalesce(array_to_string(procedure.proconfig, ','), '')) > 0
          and position('pg_temp' in coalesce(array_to_string(procedure.proconfig, ','), '')) > 0
        )
      )
      and has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
      and has_function_privilege('service_role', procedure.oid, 'EXECUTE')
      and not has_function_privilege('anon', procedure.oid, 'EXECUTE')
      and not exists (
        select 1
        from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) privilege
        where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
      ),
    format(
      'present; security_definer=%s (safe public,pg_temp path when true); authenticated/service_role execute; anon/PUBLIC denied',
      required.expected_security_definer
    ),
    case when procedure.oid is null then 'missing' else
      jsonb_build_object(
        'identity', format(
          '%I.%I(%s)', namespace.nspname, procedure.proname,
          pg_get_function_identity_arguments(procedure.oid)
        ),
        'result', pg_get_function_result(procedure.oid),
        'security_definer', procedure.prosecdef,
        'configuration', procedure.proconfig,
        'authenticated_execute', has_function_privilege('authenticated', procedure.oid, 'EXECUTE'),
        'service_role_execute', has_function_privilege('service_role', procedure.oid, 'EXECUTE'),
        'anon_execute', has_function_privilege('anon', procedure.oid, 'EXECUTE')
      )::text
    end
  from required_function_signatures required
  left join pg_proc procedure on procedure.oid = to_regprocedure(required.signature)
  left join pg_namespace namespace on namespace.oid = procedure.pronamespace

  union all

  select
    'function.can_access_renewal_evidence.contract',
    procedure.oid is not null
      and procedure.prosecdef
      and coalesce(array_to_string(procedure.proconfig, ','), '') like '%search_path=public, pg_temp%'
      and position('split_part' in lower(pg_get_functiondef(procedure.oid))) > 0
      and position('assigned_to = auth.uid()' in lower(pg_get_functiondef(procedure.oid))) > 0
      and position('is_active' in lower(pg_get_functiondef(procedure.oid))) > 0,
    'safe search_path; first-segment parse; active manager or assigned user',
    case when procedure.oid is null then 'missing'
      else jsonb_build_object(
        'security_definer', procedure.prosecdef,
        'configuration', procedure.proconfig,
        'has_first_segment_parse', position('split_part' in lower(pg_get_functiondef(procedure.oid))) > 0,
        'has_assignee_check', position('assigned_to = auth.uid()' in lower(pg_get_functiondef(procedure.oid))) > 0,
        'has_active_check', position('is_active' in lower(pg_get_functiondef(procedure.oid))) > 0
      )::text
    end
  from (values (to_regprocedure('public.can_access_renewal_evidence(text)'))) target(oid)
  left join pg_proc procedure on procedure.oid = target.oid

  union all

  select
    'function.renewal_import_batch.contract',
    procedure.oid is not null
      and position('status::text in (''renewed'', ''lost'', ''cancelled'')' in lower(pg_get_functiondef(procedure.oid))) > 0
      and position('assignment_source is distinct from ''powerbi''' in lower(pg_get_functiondef(procedure.oid))) > 0
      and position('renewal_import_seen_v0913' in lower(pg_get_functiondef(procedure.oid))) > 0
      and position('source_sync_state is distinct from ''missing_from_latest_file''' in lower(pg_get_functiondef(procedure.oid))) > 0
      and position('source_row_incomplete' in lower(pg_get_functiondef(procedure.oid))) > 0
      and position('source_record_restored' in lower(pg_get_functiondef(procedure.oid))) > 0,
    'preserves closed outcomes and non-Power-BI owners; tracks source presence, including incomplete rows, and transition-only missing/restored states',
    case when procedure.oid is null then 'missing' else
      jsonb_build_object(
        'preserves_closed', position('status::text in (''renewed'', ''lost'', ''cancelled'')' in lower(pg_get_functiondef(procedure.oid))) > 0,
        'preserves_non_powerbi_owner', position('assignment_source is distinct from ''powerbi''' in lower(pg_get_functiondef(procedure.oid))) > 0,
        'tracks_seen_keys', position('renewal_import_seen_v0913' in lower(pg_get_functiondef(procedure.oid))) > 0,
        'transition_only_missing', position('source_sync_state is distinct from ''missing_from_latest_file''' in lower(pg_get_functiondef(procedure.oid))) > 0,
        'restores_incomplete_present_rows', position('source_row_incomplete' in lower(pg_get_functiondef(procedure.oid))) > 0,
        'tracks_restoration', position('source_record_restored' in lower(pg_get_functiondef(procedure.oid))) > 0
      )::text
    end
  from (values (to_regprocedure('public.renewal_import_batch(text,jsonb,jsonb)'))) target(oid)
  left join pg_proc procedure on procedure.oid = target.oid

  union all

  select
    'function.renewal_assign.provenance',
    procedure.oid is not null
      and position('assignment_source = ''manager''' in lower(pg_get_functiondef(procedure.oid))) > 0,
    'manager assignment stamps assignment_source=manager',
    case when procedure.oid is null then 'missing' else
      jsonb_build_object(
        'stamps_manager_source', position('assignment_source = ''manager''' in lower(pg_get_functiondef(procedure.oid))) > 0
      )::text
    end
  from (values (to_regprocedure('public.renewal_assign(uuid,uuid)'))) target(oid)
  left join pg_proc procedure on procedure.oid = target.oid

  union all

  select
    'functions.app_rpc_hardening',
    not exists (
      select 1
      from app_functions required
      where (
        select count(*)
        from pg_proc procedure
        join pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = 'public'
          and procedure.proname = required.function_name
      ) <> 1
    )
    and not exists (
      select 1
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      join app_functions required on required.function_name = procedure.proname
      where namespace.nspname = 'public'
        and (
          not has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
          or not has_function_privilege('service_role', procedure.oid, 'EXECUTE')
          or has_function_privilege('anon', procedure.oid, 'EXECUTE')
          or exists (
            select 1
            from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) privilege
            where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
          )
        )
    ),
    'every enumerated app function has exactly one reviewed signature; authenticated/service_role only',
    jsonb_build_object(
      'signature_count_violations', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'function_name', required.function_name,
            'count', (
              select count(*)
              from pg_proc procedure
              join pg_namespace namespace on namespace.oid = procedure.pronamespace
              where namespace.nspname = 'public'
                and procedure.proname = required.function_name
            )
          )
          order by required.function_name
        )
        from app_functions required
        where (
          select count(*)
          from pg_proc procedure
          join pg_namespace namespace on namespace.oid = procedure.pronamespace
          where namespace.nspname = 'public'
            and procedure.proname = required.function_name
        ) <> 1
      ), '[]'::jsonb),
      'bad_overloads', coalesce((
        select jsonb_agg(
          format('public.%I(%s)', procedure.proname, pg_get_function_identity_arguments(procedure.oid))
          order by procedure.proname, pg_get_function_identity_arguments(procedure.oid)
        )
        from pg_proc procedure
        join pg_namespace namespace on namespace.oid = procedure.pronamespace
        join app_functions required on required.function_name = procedure.proname
        where namespace.nspname = 'public'
          and (
            not has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
            or not has_function_privilege('service_role', procedure.oid, 'EXECUTE')
            or has_function_privilege('anon', procedure.oid, 'EXECUTE')
            or exists (
              select 1
              from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) privilege
              where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
            )
          )
      ), '[]'::jsonb)
    )::text

  union all

  select
    'functions.application_trigger_hardening',
    count(*) > 0
      and bool_and(not has_function_privilege('anon', procedure.oid, 'EXECUTE'))
      and bool_and(not has_function_privilege('authenticated', procedure.oid, 'EXECUTE'))
      and bool_and(not exists (
        select 1
        from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) privilege
        where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
      )),
    'all public-schema functions used by public application triggers deny anon/PUBLIC/authenticated EXECUTE',
    jsonb_build_object(
      'count', count(*),
      'identities', coalesce(jsonb_agg(
        format('public.%I(%s)', procedure.proname, pg_get_function_identity_arguments(procedure.oid))
        order by procedure.proname
      ), '[]'::jsonb)
    )::text
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.oid in (
      select distinct trigger_record.tgfoid
      from pg_trigger trigger_record
      join pg_class relation on relation.oid = trigger_record.tgrelid
      join pg_namespace relation_namespace on relation_namespace.oid = relation.relnamespace
      where not trigger_record.tgisinternal
        and relation_namespace.nspname = 'public'
    )

  union all

  select
    'rls.' || required.relation_name,
    coalesce(class.relrowsecurity, false),
    'enabled',
    case when class.oid is null then 'missing' else class.relrowsecurity::text end
  from required_relations required
  left join pg_class class
    on class.relnamespace = 'public'::regnamespace
   and class.relname = required.relation_name
   and class.relkind in ('r', 'p')

  union all

  select
    'policy.legacy_absence.' || required.policy_name,
    policy.policyname is null,
    'absent',
    case when policy.policyname is not null
      then format('%I.%I.%I', policy.schemaname, policy.tablename, policy.policyname)
      else 'absent'
    end
  from legacy_policies required
  left join pg_policies policy
    on policy.schemaname = required.schema_name
   and (required.table_name is null or policy.tablename = required.table_name)
   and policy.policyname = required.policy_name

  union all

  select
    'policy.replacement.' || required.policy_name,
    policy.policyname is not null
      and policy.cmd = required.command_name
      and policy.permissive = 'PERMISSIVE'
      and policy.roles = array['authenticated']::name[]
      and not exists (
        select 1 from unnest(required.expression_tokens) token
        where position(
          lower(token)
          in lower(coalesce(policy.qual, '') || ' ' || coalesce(policy.with_check, ''))
        ) = 0
      ),
    'present; command=' || required.command_name
      || '; mode=PERMISSIVE; roles={authenticated}; expression tokens='
      || array_to_string(required.expression_tokens, ', '),
    case when policy.policyname is null then 'missing' else
      jsonb_build_object(
        'command', policy.cmd,
        'permissive', policy.permissive,
        'roles', policy.roles,
        'using', policy.qual,
        'with_check', policy.with_check
      )::text
    end
  from required_policies required
  left join pg_policies policy
    on policy.schemaname = required.schema_name
   and policy.tablename = required.table_name
   and policy.policyname = required.policy_name

  union all

  select
    'policy.unexpected_public_renewal_policies',
    count(*) = 0,
    'no public renewal policy outside the v0.9.7/v0.9.11 allowlist',
    coalesce(jsonb_agg(
      format('%I.%I.%I', policy.schemaname, policy.tablename, policy.policyname)
      order by policy.tablename, policy.policyname
    ) filter (where policy.policyname is not null), '[]'::jsonb)::text
  from pg_policies policy
  where policy.schemaname = 'public'
    and policy.tablename in (
      'renewal_records', 'renewal_contacts', 'renewal_events',
      'renewal_import_runs', 'renewal_warning_deliveries',
      'renewal_assignment_aliases'
    )
    and not exists (
      select 1 from required_policies allowed
      where allowed.schema_name = policy.schemaname
        and allowed.table_name = policy.tablename
        and allowed.policy_name = policy.policyname
    )

  union all

  select
    'policy.unexpected_renewal_evidence_policies',
    count(*) = 0,
    'no additional storage.objects policy explicitly targets renewal-contact-evidence',
    coalesce(jsonb_agg(policy.policyname order by policy.policyname)
      filter (where policy.policyname is not null), '[]'::jsonb)::text
  from pg_policies policy
  where policy.schemaname = 'storage'
    and policy.tablename = 'objects'
    and position(
      'renewal-contact-evidence'
      in lower(coalesce(policy.qual, '') || ' ' || coalesce(policy.with_check, ''))
    ) > 0
    and not exists (
      select 1 from required_policies allowed
      where allowed.schema_name = policy.schemaname
        and allowed.table_name = policy.tablename
        and allowed.policy_name = policy.policyname
    )

  union all

  select
    'policy.no_generic_authenticated_storage_bypass',
    count(*) filter (
      where position(
        'bucket_id'
        in lower(coalesce(policy.qual, '') || ' ' || coalesce(policy.with_check, ''))
      ) = 0
      or position(
        'bucket_id is not null'
        in lower(coalesce(policy.qual, '') || ' ' || coalesce(policy.with_check, ''))
      ) > 0
    ) = 0,
    'every additional permissive anon/authenticated/PUBLIC storage.objects policy is explicitly bucket-scoped',
    coalesce(jsonb_agg(
      jsonb_build_object(
        'policy_name', policy.policyname,
        'command', policy.cmd,
        'roles', policy.roles,
        'using', policy.qual,
        'with_check', policy.with_check
      ) order by policy.policyname
    ) filter (where policy.policyname is not null), '[]'::jsonb)::text
  from pg_policies policy
  where policy.schemaname = 'storage'
    and policy.tablename = 'objects'
    and policy.permissive = 'PERMISSIVE'
    and policy.roles && array['anon', 'authenticated', 'public']::name[]
    and not exists (
      select 1 from required_policies allowed
      where allowed.schema_name = policy.schemaname
        and allowed.table_name = policy.tablename
        and allowed.policy_name = policy.policyname
    )

  union all

  select
    'storage.renewal-contact-evidence',
    bucket.id is not null and not bucket.public and bucket.file_size_limit = 104857600,
    'present; private; file_size_limit=104857600',
    case when bucket.id is null then 'missing' else
      jsonb_build_object(
        'public', bucket.public,
        'file_size_limit', bucket.file_size_limit
      )::text
    end
  from (values (1)) sentinel(value)
  left join storage.buckets bucket on bucket.id = 'renewal-contact-evidence'

  union all

  select
    'privileges.application_relations_no_anon_or_public',
    not exists (
      select 1
      from app_relations required
      join pg_class class
        on class.relnamespace = 'public'::regnamespace
       and class.relname = required.relation_name
      cross join lateral aclexplode(
        coalesce(class.relacl, acldefault('r', class.relowner))
      ) privilege
      where privilege.grantee in (0, (select oid from pg_roles where rolname = 'anon'))
    ),
    'no direct relation privileges for anon or PUBLIC on enumerated application relations',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'relation', required.relation_name,
          'grantee', case when privilege.grantee = 0 then 'PUBLIC' else 'anon' end,
          'privilege', privilege.privilege_type
        ) order by required.relation_name, privilege.privilege_type
      )::text
      from app_relations required
      join pg_class class
        on class.relnamespace = 'public'::regnamespace
       and class.relname = required.relation_name
      cross join lateral aclexplode(
        coalesce(class.relacl, acldefault('r', class.relowner))
      ) privilege
      where privilege.grantee in (0, (select oid from pg_roles where rolname = 'anon'))
    ), '[]')

  union all

  select
    'privileges.application_columns_no_anon_or_public',
    not exists (
      select 1
      from app_relations required
      join pg_class class
        on class.relnamespace = 'public'::regnamespace
       and class.relname = required.relation_name
      join pg_attribute attribute
        on attribute.attrelid = class.oid
       and attribute.attnum > 0
       and not attribute.attisdropped
      cross join lateral aclexplode(attribute.attacl) privilege
      where privilege.grantee in (0, (select oid from pg_roles where rolname = 'anon'))
    )
    and not exists (
      select 1
      from app_relations required
      join pg_class class
        on class.relnamespace = 'public'::regnamespace
       and class.relname = required.relation_name
      where has_any_column_privilege(
        'anon',
        class.oid,
        'SELECT,INSERT,UPDATE,REFERENCES'
      )
    ),
    'no direct or inherited anon/PUBLIC column privileges on enumerated application relations',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'relation', required.relation_name,
          'column', attribute.attname,
          'grantee', case when privilege.grantee = 0 then 'PUBLIC' else 'anon' end,
          'privilege', privilege.privilege_type
        ) order by required.relation_name, attribute.attnum, privilege.privilege_type
      )::text
      from app_relations required
      join pg_class class
        on class.relnamespace = 'public'::regnamespace
       and class.relname = required.relation_name
      join pg_attribute attribute
        on attribute.attrelid = class.oid
       and attribute.attnum > 0
       and not attribute.attisdropped
      cross join lateral aclexplode(attribute.attacl) privilege
      where privilege.grantee in (0, (select oid from pg_roles where rolname = 'anon'))
    ), '[]')

  union all

  select
    'privileges.authenticated_no_column_references',
    not exists (
      select 1
      from app_relations required
      join pg_class class
        on class.relnamespace = 'public'::regnamespace
       and class.relname = required.relation_name
      join pg_attribute attribute
        on attribute.attrelid = class.oid
       and attribute.attnum > 0
       and not attribute.attisdropped
      cross join lateral aclexplode(attribute.attacl) privilege
      where privilege.grantee = (select oid from pg_roles where rolname = 'authenticated')
        and privilege.privilege_type = 'REFERENCES'
    ),
    'authenticated lacks column-level REFERENCES on enumerated application relations',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'relation', required.relation_name,
          'column', attribute.attname,
          'privilege', privilege.privilege_type
        ) order by required.relation_name, attribute.attnum
      )::text
      from app_relations required
      join pg_class class
        on class.relnamespace = 'public'::regnamespace
       and class.relname = required.relation_name
      join pg_attribute attribute
        on attribute.attrelid = class.oid
       and attribute.attnum > 0
       and not attribute.attisdropped
      cross join lateral aclexplode(attribute.attacl) privilege
      where privilege.grantee = (select oid from pg_roles where rolname = 'authenticated')
        and privilege.privilege_type = 'REFERENCES'
    ), '[]')

  union all

  select
    'privileges.authenticated_no_elevated_relation_privileges',
    not exists (
      select 1
      from app_relations required
      join pg_class class
        on class.relnamespace = 'public'::regnamespace
       and class.relname = required.relation_name
      cross join lateral aclexplode(
        coalesce(class.relacl, acldefault('r', class.relowner))
      ) privilege
      where privilege.grantee = (select oid from pg_roles where rolname = 'authenticated')
        and privilege.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')
    ),
    'authenticated lacks TRUNCATE, REFERENCES, TRIGGER, and MAINTAIN on enumerated relations',
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'relation', required.relation_name,
          'privilege', privilege.privilege_type
        ) order by required.relation_name, privilege.privilege_type
      )::text
      from app_relations required
      join pg_class class
        on class.relnamespace = 'public'::regnamespace
       and class.relname = required.relation_name
      cross join lateral aclexplode(
        coalesce(class.relacl, acldefault('r', class.relowner))
      ) privilege
      where privilege.grantee = (select oid from pg_roles where rolname = 'authenticated')
        and privilege.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN')
    ), '[]')

  union all

  select
    'realtime.renewal_relations_absent',
    count(*) = 0,
    'no renewal_* relation in any publication',
    coalesce(jsonb_agg(
      format('%I:%I.%I', publication.pubname, publication_table.schemaname, publication_table.tablename)
      order by publication.pubname, publication_table.tablename
    ) filter (where publication.pubname is not null), '[]'::jsonb)::text
  from pg_publication_tables publication_table
  join pg_publication publication on publication.pubname = publication_table.pubname
  where publication_table.schemaname = 'public'
    and publication_table.tablename like 'renewal\_%' escape '\'

  union all

  select
    'realtime.expected_work_desk_membership',
    not exists (
      select 1 from expected_realtime required
      where not exists (
        select 1 from pg_publication_tables publication_table
        where publication_table.pubname = 'supabase_realtime'
          and publication_table.schemaname = 'public'
          and publication_table.tablename = required.relation_name
      )
    ),
    'known quote/work-desk relations remain in supabase_realtime',
    jsonb_build_object(
      'missing', coalesce((
        select jsonb_agg(required.relation_name order by required.relation_name)
        from expected_realtime required
        where not exists (
          select 1 from pg_publication_tables publication_table
          where publication_table.pubname = 'supabase_realtime'
            and publication_table.schemaname = 'public'
            and publication_table.tablename = required.relation_name
        )
      ), '[]'::jsonb)
    )::text
)
select check_name, pass, expected, actual
from checks
order by pass, check_name;
