-- REPO definition extracted from supabase/schema.sql line 206
-- for comparison against the live dump in ../live-functions/is_agent.sql

create or replace function public.is_agent()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'agent' and is_active
  );
$$;
