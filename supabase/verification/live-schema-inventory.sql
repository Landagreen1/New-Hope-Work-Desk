-- New Hope Work Desk live Supabase schema inventory
--
-- Purpose:
--   Produce one exportable, metadata-only result set that can be compared with
--   repository migrations before any new database work is designed or applied.
--
-- Safety:
--   Read-only. This script does not inspect application/customer rows and does
--   not create, alter, or delete database objects.
--
-- Run in Supabase SQL Editor with the postgres project role, then export the
-- complete result grid as CSV or JSON. Keep the raw export private until any
-- function definitions have been reviewed for accidentally hard-coded secrets.
-- Do not commit the raw export. Commit the reviewed reconciliation migration and
-- verification checks produced from it.

with
required_relations(schema_name, object_name) as (
  values
    ('public', 'profiles'),
    ('public', 'dealers'),
    ('public', 'dealer_salespeople'),
    ('public', 'rotation_state'),
    ('public', 'availability_day_state'),
    ('public', 'daily_rotation_starts'),
    ('public', 'work_items'),
    ('public', 'pending_pricing_quotes'),
    ('public', 'quote_outcomes'),
    ('public', 'turn_events'),
    ('public', 'quote_take_timers'),
    ('public', 'audit_log'),
    ('public', 'user_notifications'),
    ('public', 'work_item_events'),
    ('public', 'cs_intake_submissions'),
    ('public', 'cs_intake_drivers'),
    ('public', 'cs_intake_vehicles'),
    ('public', 'cs_intake_events'),
    ('public', 'renewal_records'),
    ('public', 'renewal_contacts'),
    ('public', 'renewal_events'),
    ('public', 'renewal_import_runs'),
    ('public', 'renewal_assignment_aliases'),
    ('public', 'renewal_warning_deliveries'),
    ('public', 'quote_reporting_feed'),
    ('public', 'pending_pricing_follow_up'),
    ('public', 'daily_agent_performance')
),
required_columns(schema_name, table_name, column_name) as (
  values
    ('public', 'work_items', 'salesperson_id'),
    ('public', 'work_items', 'assigned_at'),
    ('public', 'work_items', 'related_quote_source_work_item_id'),
    ('public', 'cs_intake_submissions', 'quote_kind'),
    ('public', 'cs_intake_submissions', 'source_renewal_id'),
    ('public', 'cs_intake_submissions', 'business_name'),
    ('public', 'cs_intake_submissions', 'dot_number'),
    ('public', 'cs_intake_submissions', 'desired_coverage'),
    ('public', 'cs_intake_drivers', 'document_type'),
    ('public', 'renewal_records', 'requote_intake_id'),
    ('public', 'renewal_records', 'notice_call_at'),
    ('public', 'renewal_records', 'import_notes'),
    ('public', 'renewal_records', 'eft_enabled'),
    ('public', 'renewal_records', 'requote_requested'),
    ('public', 'renewal_records', 'requote_note'),
    ('public', 'renewal_records', 'assigned_import_label'),
    ('public', 'renewal_records', 'powerbi_raw'),
    ('public', 'renewal_records', 'assignment_source'),
    ('public', 'renewal_records', 'last_seen_import_run_id'),
    ('public', 'renewal_records', 'last_seen_imported_at'),
    ('public', 'renewal_records', 'source_sync_state'),
    ('public', 'renewal_records', 'missing_since_import_run_id'),
    ('public', 'renewal_contacts', 'evidence_path'),
    ('public', 'renewal_contacts', 'evidence_reference'),
    ('public', 'renewal_contacts', 'rc_call_id'),
    ('public', 'renewal_contacts', 'rc_session_id'),
    ('public', 'renewal_contacts', 'rc_recording_content_uri'),
    ('public', 'renewal_import_runs', 'rows_assigned'),
    ('public', 'renewal_import_runs', 'rows_requote_flagged'),
    ('public', 'renewal_import_runs', 'rows_missing_in_window'),
    ('public', 'renewal_import_runs', 'rows_restored_present'),
    ('public', 'renewal_import_runs', 'distinct_assignee_labels'),
    ('public', 'renewal_import_runs', 'file_date_min'),
    ('public', 'renewal_import_runs', 'file_date_max')
),
required_functions(schema_name, function_name) as (
  values
    ('public', 'complete_password_change'),
    ('public', 'ensure_daily_availability_reset'),
    ('public', 'claim_whatsapp_quote'),
    ('public', 'claim_ringcentral_quote'),
    ('public', 'claim_workload_turn'),
    ('public', 'log_whatsapp_update'),
    ('public', 'log_manual_quote'),
    ('public', 'pass_my_turn'),
    ('public', 'move_my_quote_to_pending_pricing'),
    ('public', 'finalize_my_active_quote'),
    ('public', 'finalize_pending_pricing_quote'),
    ('public', 'complete_my_service_item'),
    ('public', 'manager_create_and_assign_quote'),
    ('public', 'manager_set_rotation_current'),
    ('public', 'manager_set_rotation_eligibility'),
    ('public', 'manager_set_queue_order'),
    ('public', 'manager_reassign_work_item'),
    ('public', 'manager_reassign_pending_pricing'),
    ('public', 'start_quote_take_timer_v094'),
    ('public', 'send_quote_take_timer_warning'),
    ('public', 'workload_log_list'),
    ('public', 'workload_reassign'),
    ('public', 'workload_void'),
    ('public', 'admin_deactivate_profile'),
    ('public', 'cs_intake_submit'),
    ('public', 'cs_intake_claim'),
    ('public', 'cs_intake_manager_assign'),
    ('public', 'cs_intake_return'),
    ('public', 'cs_intake_convert'),
    ('public', 'renewal_update_workflow'),
    ('public', 'renewal_update_contact_info'),
    ('public', 'renewal_manager_update'),
    ('public', 'renewal_assign'),
    ('public', 'renewal_send_to_requote'),
    ('public', 'renewal_import_batch'),
    ('public', 'renewal_generate_due_notifications'),
    ('public', 'renewal_upsert_assignment_alias'),
    ('public', 'renewal_delete_assignment_alias')
),
contract_checks as (
  select
    '00_contract_relation'::text as object_kind,
    required.schema_name,
    required.object_name,
    format('%I.%I', required.schema_name, required.object_name) as object_identity,
    jsonb_build_object(
      'present', to_regclass(format('%I.%I', required.schema_name, required.object_name)) is not null
    ) as metadata
  from required_relations required

  union all

  select
    '00_contract_column',
    required.schema_name,
    required.table_name,
    format('%I.%I.%I', required.schema_name, required.table_name, required.column_name),
    jsonb_build_object(
      'column_name', required.column_name,
      'present', columns.column_name is not null,
      'data_type', columns.data_type,
      'udt_name', columns.udt_name,
      'nullable', columns.is_nullable
    )
  from required_columns required
  left join information_schema.columns columns
    on columns.table_schema = required.schema_name
   and columns.table_name = required.table_name
   and columns.column_name = required.column_name

  union all

  select
    '00_contract_function',
    required.schema_name,
    required.function_name,
    format('%I.%I', required.schema_name, required.function_name),
    jsonb_build_object(
      'present', exists (
        select 1
        from pg_proc procedure
        join pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = required.schema_name
          and procedure.proname = required.function_name
      ),
      'overload_count', (
        select count(*)
        from pg_proc procedure
        join pg_namespace namespace on namespace.oid = procedure.pronamespace
        where namespace.nspname = required.schema_name
          and procedure.proname = required.function_name
      )
    )
  from required_functions required

  union all

  select
    '00_contract_bucket',
    'storage',
    'renewal-contact-evidence',
    'storage.renewal-contact-evidence',
    jsonb_build_object(
      'present', bucket.id is not null,
      'public', bucket.public,
      'file_size_limit', bucket.file_size_limit,
      'expected_private', true,
      'application_max_bytes', 104857600,
      'limit_matches_application', bucket.file_size_limit = 104857600
    )
  from (values (1)) sentinel(value)
  left join storage.buckets bucket on bucket.id = 'renewal-contact-evidence'
),
schema_inventory as (
  select
    '10_schema'::text as object_kind,
    namespace.nspname::text as schema_name,
    namespace.nspname::text as object_name,
    namespace.nspname::text as object_identity,
    jsonb_build_object(
      'owner', pg_get_userbyid(namespace.nspowner),
      'acl', namespace.nspacl,
      'comment', obj_description(namespace.oid, 'pg_namespace')
    ) as metadata
  from pg_namespace namespace
  where namespace.nspname !~ '^pg_'
    and namespace.nspname <> 'information_schema'
),
extension_inventory as (
  select
    '11_extension'::text,
    namespace.nspname::text,
    extension.extname::text,
    extension.extname::text,
    jsonb_build_object(
      'version', extension.extversion,
      'relocatable', extension.extrelocatable
    )
  from pg_extension extension
  join pg_namespace namespace on namespace.oid = extension.extnamespace
),
type_inventory as (
  select
    '20_enum'::text,
    namespace.nspname::text,
    enum_type.typname::text,
    format('%I.%I', namespace.nspname, enum_type.typname),
    jsonb_build_object(
      'owner', pg_get_userbyid(enum_type.typowner),
      'labels', jsonb_agg(enum.enumlabel order by enum.enumsortorder)
    )
  from pg_type enum_type
  join pg_namespace namespace on namespace.oid = enum_type.typnamespace
  join pg_enum enum on enum.enumtypid = enum_type.oid
  where namespace.nspname in ('public', 'storage')
  group by namespace.nspname, enum_type.typname, enum_type.typowner
),
relation_inventory as (
  select
    '30_relation'::text,
    namespace.nspname::text,
    relation.relname::text,
    format('%I.%I', namespace.nspname, relation.relname),
    jsonb_build_object(
      'kind', relation.relkind,
      'owner', pg_get_userbyid(relation.relowner),
      'persistence', relation.relpersistence,
      'row_security', relation.relrowsecurity,
      'force_row_security', relation.relforcerowsecurity,
      'replica_identity', relation.relreplident,
      'approximate_rows', relation.reltuples::bigint,
      'comment', obj_description(relation.oid, 'pg_class'),
      'view_definition', case
        when relation.relkind in ('v', 'm') then pg_get_viewdef(relation.oid, true)
        else null
      end
    )
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname in ('public', 'storage')
    and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
),
column_inventory as (
  select
    '31_column'::text,
    namespace.nspname::text,
    relation.relname::text,
    format('%I.%I.%I', namespace.nspname, relation.relname, attribute.attname),
    jsonb_build_object(
      'position', attribute.attnum,
      'column_name', attribute.attname,
      'data_type', format_type(attribute.atttypid, attribute.atttypmod),
      'not_null', attribute.attnotnull,
      'identity', attribute.attidentity,
      'generated', attribute.attgenerated,
      'default', pg_get_expr(default_value.adbin, default_value.adrelid),
      'acl', attribute.attacl,
      'collation', column_collation.collname,
      'comment', col_description(relation.oid, attribute.attnum)
    )
  from pg_attribute attribute
  join pg_class relation on relation.oid = attribute.attrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  left join pg_attrdef default_value
    on default_value.adrelid = attribute.attrelid
   and default_value.adnum = attribute.attnum
  left join pg_collation column_collation on column_collation.oid = attribute.attcollation
  where namespace.nspname in ('public', 'storage')
    and relation.relkind in ('r', 'p', 'v', 'm', 'f')
    and attribute.attnum > 0
    and not attribute.attisdropped
),
constraint_inventory as (
  select
    '32_constraint'::text,
    namespace.nspname::text,
    relation.relname::text,
    format('%I.%I.%I', namespace.nspname, relation.relname, constraint_record.conname),
    jsonb_build_object(
      'constraint_name', constraint_record.conname,
      'type', constraint_record.contype,
      'definition', pg_get_constraintdef(constraint_record.oid, true),
      'deferrable', constraint_record.condeferrable,
      'deferred', constraint_record.condeferred,
      'validated', constraint_record.convalidated,
      'referenced_relation', case
        when constraint_record.confrelid = 0 then null
        else constraint_record.confrelid::regclass::text
      end
    )
  from pg_constraint constraint_record
  join pg_class relation on relation.oid = constraint_record.conrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname in ('public', 'storage')
),
index_inventory as (
  select
    '33_index'::text,
    namespace.nspname::text,
    relation.relname::text,
    format('%I.%I', namespace.nspname, index_relation.relname),
    jsonb_build_object(
      'table_name', relation.relname,
      'index_name', index_relation.relname,
      'unique', index_record.indisunique,
      'primary', index_record.indisprimary,
      'valid', index_record.indisvalid,
      'ready', index_record.indisready,
      'definition', pg_get_indexdef(index_relation.oid)
    )
  from pg_index index_record
  join pg_class relation on relation.oid = index_record.indrelid
  join pg_class index_relation on index_relation.oid = index_record.indexrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname in ('public', 'storage')
),
function_inventory as (
  select
    '40_function'::text,
    namespace.nspname::text,
    procedure.proname::text,
    format(
      '%I.%I(%s)',
      namespace.nspname,
      procedure.proname,
      pg_get_function_identity_arguments(procedure.oid)
    ),
    jsonb_build_object(
      'kind', procedure.prokind,
      'owner', pg_get_userbyid(procedure.proowner),
      'language', language.lanname,
      'arguments', pg_get_function_arguments(procedure.oid),
      'identity_arguments', pg_get_function_identity_arguments(procedure.oid),
      'result', pg_get_function_result(procedure.oid),
      'security_definer', procedure.prosecdef,
      'leakproof', procedure.proleakproof,
      'strict', procedure.proisstrict,
      'volatility', procedure.provolatile,
      'parallel', procedure.proparallel,
      'configuration', procedure.proconfig,
      'acl', procedure.proacl,
      'anon_execute', has_function_privilege('anon', procedure.oid, 'EXECUTE'),
      'authenticated_execute', has_function_privilege('authenticated', procedure.oid, 'EXECUTE'),
      'service_role_execute', has_function_privilege('service_role', procedure.oid, 'EXECUTE'),
      'definition', pg_get_functiondef(procedure.oid)
    )
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  join pg_language language on language.oid = procedure.prolang
  where namespace.nspname in ('public', 'storage')
    and procedure.prokind <> 'a'
),
trigger_inventory as (
  select
    '41_trigger'::text,
    namespace.nspname::text,
    relation.relname::text,
    format('%I.%I.%I', namespace.nspname, relation.relname, trigger_record.tgname),
    jsonb_build_object(
      'trigger_name', trigger_record.tgname,
      'enabled', trigger_record.tgenabled,
      'function', trigger_record.tgfoid::regprocedure::text,
      'definition', pg_get_triggerdef(trigger_record.oid, true)
    )
  from pg_trigger trigger_record
  join pg_class relation on relation.oid = trigger_record.tgrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname in ('public', 'storage')
    and not trigger_record.tgisinternal
),
policy_inventory as (
  select
    '42_policy'::text,
    policy.schemaname::text,
    policy.tablename::text,
    format('%I.%I.%I', policy.schemaname, policy.tablename, policy.policyname),
    jsonb_build_object(
      'policy_name', policy.policyname,
      'permissive', policy.permissive,
      'roles', policy.roles,
      'command', policy.cmd,
      'using', policy.qual,
      'with_check', policy.with_check
    )
  from pg_policies policy
  where policy.schemaname in ('public', 'storage')
),
relation_acl_inventory as (
  select
    '43_relation_grant'::text,
    namespace.nspname::text,
    relation.relname::text,
    format(
      '%I.%I:%s:%s',
      namespace.nspname,
      relation.relname,
      coalesce(grantee.rolname, 'public'),
      privilege.privilege_type
    ),
    jsonb_build_object(
      'grantee', coalesce(grantee.rolname, 'public'),
      'grantor', grantor.rolname,
      'privilege', privilege.privilege_type,
      'grantable', privilege.is_grantable
    )
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  cross join lateral aclexplode(
    coalesce(
      relation.relacl,
      acldefault(case when relation.relkind = 'S' then 'S'::"char" else 'r'::"char" end, relation.relowner)
    )
  ) privilege
  left join pg_roles grantee on grantee.oid = privilege.grantee
  left join pg_roles grantor on grantor.oid = privilege.grantor
  where namespace.nspname in ('public', 'storage')
    and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
),
publication_inventory as (
  select
    '50_publication_table'::text,
    publication_table.schemaname::text,
    publication_table.tablename::text,
    format('%I:%I.%I', publication_table.pubname, publication_table.schemaname, publication_table.tablename),
    jsonb_build_object('publication', publication_table.pubname)
  from pg_publication_tables publication_table
  where publication_table.schemaname in ('public', 'storage')
),
storage_inventory as (
  select
    '60_storage_bucket'::text,
    'storage'::text,
    bucket.id::text,
    format('storage.%s', bucket.id),
    jsonb_build_object(
      'name', bucket.name,
      'public', bucket.public,
      'file_size_limit', bucket.file_size_limit,
      'allowed_mime_types', bucket.allowed_mime_types,
      'created_at', bucket.created_at,
      'updated_at', bucket.updated_at
    )
  from storage.buckets bucket
),
all_inventory as (
  select * from contract_checks
  union all select * from schema_inventory
  union all select * from extension_inventory
  union all select * from type_inventory
  union all select * from relation_inventory
  union all select * from column_inventory
  union all select * from constraint_inventory
  union all select * from index_inventory
  union all select * from function_inventory
  union all select * from trigger_inventory
  union all select * from policy_inventory
  union all select * from relation_acl_inventory
  union all select * from publication_inventory
  union all select * from storage_inventory
)
select
  object_kind,
  schema_name,
  object_name,
  object_identity,
  metadata
from all_inventory
order by object_kind, schema_name, object_name, object_identity;
