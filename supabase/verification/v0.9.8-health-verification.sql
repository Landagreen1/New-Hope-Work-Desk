-- New Hope Work Desk v0.9.8 health verification
-- Run after v0.9.8-stabilize-integrations.sql.
-- All checks are read-only except the reset execution test, which is rolled back.

-- 1. Core and module tables.
select
  'tables' as check_group,
  required.object_name,
  to_regclass(required.object_name) is not null as present
from (values
  ('public.profiles'),
  ('public.work_items'),
  ('public.dealers'),
  ('public.dealer_salespeople'),
  ('public.cs_intake_submissions'),
  ('public.cs_intake_drivers'),
  ('public.cs_intake_vehicles'),
  ('public.cs_intake_events'),
  ('public.renewal_records'),
  ('public.renewal_contacts'),
  ('public.renewal_events'),
  ('public.renewal_import_runs'),
  ('public.renewal_warning_deliveries')
) as required(object_name)
order by required.object_name;

-- 2. Required intake and renewal columns.
select
  'columns' as check_group,
  required.table_name,
  required.column_name,
  columns.column_name is not null as present,
  columns.data_type,
  columns.udt_name
from (values
  ('cs_intake_submissions','quote_kind'),
  ('cs_intake_submissions','source_renewal_id'),
  ('cs_intake_submissions','business_name'),
  ('cs_intake_submissions','dot_number'),
  ('cs_intake_submissions','business_type'),
  ('cs_intake_submissions','desired_coverage'),
  ('cs_intake_drivers','document_type'),
  ('renewal_records','requote_intake_id'),
  ('renewal_contacts','evidence_path'),
  ('renewal_contacts','evidence_reference'),
  ('renewal_contacts','rc_call_id'),
  ('renewal_contacts','rc_session_id'),
  ('renewal_contacts','rc_recording_content_uri')
) as required(table_name, column_name)
left join information_schema.columns columns
  on columns.table_schema = 'public'
 and columns.table_name = required.table_name
 and columns.column_name = required.column_name
order by required.table_name, required.column_name;

-- 3. Required RPCs and security mode.
with required(signature) as (
  values
    ('public.cs_intake_submit(uuid)'),
    ('public.cs_intake_claim(uuid)'),
    ('public.cs_intake_manager_assign(uuid,uuid)'),
    ('public.cs_intake_return(uuid,text)'),
    ('public.cs_intake_convert(uuid)'),
    ('public.renewal_update_workflow(uuid,text,timestamptz,text)'),
    ('public.renewal_assign(uuid,uuid)'),
    ('public.renewal_manager_update(uuid,jsonb)'),
    ('public.renewal_send_to_requote(uuid)'),
    ('public.renewal_import_batch(text,jsonb,jsonb)'),
    ('public.renewal_generate_due_notifications()'),
    ('public.ensure_daily_availability_reset()')
)
select
  'functions' as check_group,
  required.signature,
  to_regprocedure(required.signature) is not null as present,
  coalesce(proc.prosecdef, false) as security_definer,
  has_function_privilege('authenticated', required.signature, 'EXECUTE') as authenticated_can_execute,
  has_function_privilege('service_role', required.signature, 'EXECUTE') as service_role_can_execute,
  has_function_privilege('anon', required.signature, 'EXECUTE') as anon_can_execute
from required
left join pg_proc proc on proc.oid = to_regprocedure(required.signature)
order by required.signature;

-- Expected for every row:
-- present = true, security_definer = true,
-- authenticated_can_execute = true, service_role_can_execute = true,
-- anon_can_execute = false.

-- 4. RLS state and role-aware policies.
select
  'rls' as check_group,
  class.relname as table_name,
  class.relrowsecurity as rls_enabled
from pg_class class
join pg_namespace namespace on namespace.oid = class.relnamespace
where namespace.nspname = 'public'
  and class.relname in (
    'cs_intake_submissions','cs_intake_drivers','cs_intake_vehicles','cs_intake_events',
    'renewal_records','renewal_contacts','renewal_events','renewal_import_runs','renewal_warning_deliveries'
  )
order by class.relname;

select
  'policies' as check_group,
  schemaname,
  tablename,
  policyname,
  cmd,
  roles
from pg_policies
where schemaname in ('public','storage')
  and (
    tablename like 'cs_intake%'
    or tablename like 'renewal%'
    or policyname like '%v097%'
  )
order by schemaname, tablename, policyname;

-- 5. Private evidence storage.
select
  'storage' as check_group,
  id,
  name,
  public,
  file_size_limit,
  case when id = 'renewal-contact-evidence' and public = false then 'PASS' else 'CHECK' end as result
from storage.buckets
where id = 'renewal-contact-evidence';

-- 6. Active role distribution. Customer Service should appear as its own role.
select
  'roles' as check_group,
  role::text,
  count(*) as active_users
from public.profiles
where is_active
group by role::text
order by role::text;

-- 7. Database link between module work and the existing Quotes Database.
select
  'integration' as check_group,
  count(*) filter (where received_through = 'cs_intake') as quotes_created_from_cs_intake,
  count(*) filter (where received_through = 'renewal') as quotes_created_directly_from_renewal,
  count(*) filter (where work_type::text = 'requote') as total_requotes
from public.work_items;

select
  'integration' as check_group,
  count(*) as converted_intakes,
  count(*) filter (where work_item_id is not null) as converted_with_work_item_link
from public.cs_intake_submissions
where status::text = 'converted';

select
  'integration' as check_group,
  count(*) as requote_sent_renewals,
  count(*) filter (where requote_intake_id is not null or requote_work_item_id is not null) as requotes_with_link
from public.renewal_records
where status::text = 'requote_sent';

-- 8. Daily reset definition must contain explicit WHERE clauses and grants.
select
  'daily_reset' as check_group,
  pg_get_userbyid(proc.proowner) as owner,
  proc.prosecdef as security_definer,
  position('where kind' in lower(pg_get_functiondef(proc.oid))) > 0 as rotation_update_has_where,
  position('where role' in lower(pg_get_functiondef(proc.oid))) > 0 as profile_update_has_where,
  has_function_privilege('authenticated','public.ensure_daily_availability_reset()','EXECUTE') as authenticated_can_execute,
  has_function_privilege('anon','public.ensure_daily_availability_reset()','EXECUTE') as anon_can_execute
from pg_proc proc
join pg_namespace namespace on namespace.oid = proc.pronamespace
where namespace.nspname = 'public'
  and proc.proname = 'ensure_daily_availability_reset'
  and pg_get_function_identity_arguments(proc.oid) = '';

-- 9. Execute reset as authenticated, but roll back any state change.
begin;
set local role authenticated;
select public.ensure_daily_availability_reset() as authenticated_reset_test;
rollback;

select 'New Hope Work Desk v0.9.8 health verification completed' as status;
