-- REPO definition extracted from supabase/schema.sql line 1712
-- for comparison against the live dump in ../live-functions/ensure_daily_availability_reset.sql

create or replace function public.ensure_daily_availability_reset()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.current_business_date();
  v_last_business_date date;
begin
  perform pg_advisory_xact_lock(707200072);

  insert into public.availability_day_state(singleton_key, business_date, reset_at)
  values (true, v_today, now())
  on conflict (singleton_key) do nothing;

  select business_date
  into v_last_business_date
  from public.availability_day_state
  where singleton_key = true
  for update;

  if v_last_business_date < v_today then
    update public.profiles
    set availability = 'unavailable'
    where role = 'agent'
      and is_active
      and availability <> 'unavailable';

    update public.availability_day_state
    set business_date = v_today,
        reset_at = now()
    where singleton_key = true;

    return true;
  end if;

  return false;
end;
$$;
