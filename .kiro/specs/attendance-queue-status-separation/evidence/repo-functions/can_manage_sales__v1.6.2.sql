-- REPO definition extracted from supabase/migrations/v1.6.2-enforce-scoped-supervisor-access.sql line 22
-- for comparison against the live dump in ../live-functions/can_manage_sales.sql

create or replace function public.can_manage_sales()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('manager', 'sales_supervisor', 'super_admin')
      and is_active
  );
$$;
