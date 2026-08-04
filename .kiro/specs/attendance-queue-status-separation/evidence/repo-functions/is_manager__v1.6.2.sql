-- REPO definition extracted from supabase/migrations/v1.6.2-enforce-scoped-supervisor-access.sql line 7
-- for comparison against the live dump in ../live-functions/is_manager.sql

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('manager', 'super_admin')
      and is_active
  );
$$;
