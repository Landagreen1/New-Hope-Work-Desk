-- New Hope Work Desk v0.9.7 read-only verification

-- 1. Required intake columns
select
  'intake_columns' as check_group,
  column_name,
  data_type,
  udt_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'cs_intake_submissions'
  and column_name in (
    'quote_kind','source_renewal_id','business_name','dot_number','dot_not_applicable',
    'business_type','years_in_business','operating_radius_miles','desired_coverage',
    'liability_limit','comprehensive_deductible','collision_deductible'
  )
order by column_name;

-- 2. Renewal and evidence columns
select
  'renewal_columns' as check_group,
  table_name,
  column_name,
  data_type
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'renewal_records' and column_name = 'requote_intake_id')
    or
    (table_name = 'renewal_contacts' and column_name in (
      'evidence_path','evidence_name','evidence_reference','evidence_mime_type','evidence_size_bytes'
    ))
  )
order by table_name, column_name;

-- 3. Required functions
select
  'functions' as check_group,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'cs_intake_submit',
    'cs_intake_manager_assign',
    'cs_intake_return',
    'cs_intake_convert',
    'renewal_update_workflow',
    'renewal_assign',
    'renewal_manager_update',
    'renewal_send_to_requote',
    'renewal_import_batch',
    'renewal_generate_due_notifications'
  )
order by p.proname;

-- 4. Renewal contact triggers
select
  'triggers' as check_group,
  event_object_table,
  trigger_name,
  action_timing,
  event_manipulation
from information_schema.triggers
where trigger_schema = 'public'
  and event_object_table = 'renewal_contacts'
  and trigger_name like '%v097%'
order by trigger_name;

-- 5. New tables and RLS
select
  'tables_rls' as check_group,
  c.relname as table_name,
  c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('renewal_import_runs','renewal_warning_deliveries')
order by c.relname;

-- 6. Private evidence bucket
select
  'storage_bucket' as check_group,
  id,
  name,
  public,
  file_size_limit
from storage.buckets
where id = 'renewal-contact-evidence';

-- 7. Active users by role
select
  'active_roles' as check_group,
  role::text,
  count(*) as active_users
from public.profiles
where is_active
group by role::text
order by role::text;

-- 8. Relevant RLS policies
select
  'policies' as check_group,
  schemaname,
  tablename,
  policyname,
  cmd
from pg_policies
where policyname like '%v097%'
order by schemaname, tablename, policyname;

-- 9. Existing data summary (read-only)
select
  'data_summary' as check_group,
  (select count(*) from public.cs_intake_submissions) as intake_records,
  (select count(*) from public.renewal_records) as renewal_records,
  (select count(*) from public.renewal_contacts) as renewal_contacts,
  (select count(*) from public.renewal_import_runs) as v097_import_runs;

-- Expected function count: at least 10 rows in section 3.
-- Expected bucket: renewal-contact-evidence with public = false.
