-- New Hope Work Desk v1.3.3 — Fix is_manager() to include super_admin
-- The is_manager() helper function is used throughout DB functions to gate
-- manager-level actions. It must also return true for super_admin.

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('manager', 'super_admin') and is_active
  );
$$;
