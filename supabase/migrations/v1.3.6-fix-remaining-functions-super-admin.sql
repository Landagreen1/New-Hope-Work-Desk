-- New Hope Work Desk v1.3.6 — Fix remaining DB functions for super_admin
-- Updates hardcoded role = 'manager' checks in intake, duplicate, and evidence functions.

-- can_access_renewal_evidence: allow super_admin to view evidence
do $$
declare
  v_src text;
begin
  select pg_get_functiondef(oid) into v_src
  from pg_proc
  where proname = 'can_access_renewal_evidence'
    and pronamespace = 'public'::regnamespace;

  v_src := replace(v_src, 'profile.role::text = ''manager''', 'profile.role::text in (''manager'', ''super_admin'')');
  execute v_src;
end $$;

-- delete_customer_intake: allow super_admin
do $$
declare
  v_src text;
begin
  select pg_get_functiondef(oid) into v_src
  from pg_proc
  where proname = 'delete_customer_intake'
    and pronamespace = 'public'::regnamespace;

  v_src := replace(v_src, 'v_caller.role != ''manager''', 'v_caller.role not in (''manager'', ''super_admin'')');
  execute v_src;
end $$;

-- restore_customer_intake: allow super_admin
do $$
declare
  v_src text;
begin
  select pg_get_functiondef(oid) into v_src
  from pg_proc
  where proname = 'restore_customer_intake'
    and pronamespace = 'public'::regnamespace;

  v_src := replace(v_src, 'v_caller.role != ''manager''', 'v_caller.role not in (''manager'', ''super_admin'')');
  execute v_src;
end $$;

-- merge_quote_records: allow super_admin
do $$
declare
  v_src text;
begin
  select pg_get_functiondef(oid) into v_src
  from pg_proc
  where proname = 'merge_quote_records'
    and pronamespace = 'public'::regnamespace;

  v_src := replace(v_src, 'v_caller.role != ''manager''', 'v_caller.role not in (''manager'', ''super_admin'')');
  execute v_src;
end $$;

-- resolve_quote_duplicate: allow super_admin
do $$
declare
  v_src text;
begin
  select pg_get_functiondef(oid) into v_src
  from pg_proc
  where proname = 'resolve_quote_duplicate'
    and pronamespace = 'public'::regnamespace;

  v_src := replace(v_src, 'v_caller.role != ''manager''', 'v_caller.role not in (''manager'', ''super_admin'')');
  execute v_src;
end $$;

-- flag_quote_duplicate: allow super_admin (already allows agent + manager)
do $$
declare
  v_src text;
begin
  select pg_get_functiondef(oid) into v_src
  from pg_proc
  where proname = 'flag_quote_duplicate'
    and pronamespace = 'public'::regnamespace;

  v_src := replace(v_src, 'v_caller.role not in (''agent'', ''manager'')', 'v_caller.role not in (''agent'', ''manager'', ''super_admin'')');
  execute v_src;
end $$;

-- update_customer_intake: allow super_admin (manager path)
do $$
declare
  v_src text;
begin
  select pg_get_functiondef(oid) into v_src
  from pg_proc
  where proname = 'update_customer_intake'
    and pronamespace = 'public'::regnamespace;

  v_src := replace(v_src, 'v_caller.role::text = ''manager''', 'v_caller.role::text in (''manager'', ''super_admin'')');
  execute v_src;
end $$;
