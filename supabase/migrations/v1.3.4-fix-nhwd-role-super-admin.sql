-- New Hope Work Desk v1.3.4 — Fix nhwd_role() for super_admin
-- The nhwd_role() function is used in RLS policies and DB functions throughout
-- the renewals and customer service modules. It compares against 'manager'.
-- We update it to return 'manager' when the actual role is 'super_admin',
-- so all existing manager-level access checks automatically apply to super_admin.

create or replace function public.nhwd_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when role = 'super_admin' then 'manager'
    else role::text
  end
  from profiles
  where id = auth.uid()
$$;
