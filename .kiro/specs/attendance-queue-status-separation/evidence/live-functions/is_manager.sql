-- LIVE definition dumped from Supabase project kfbgftkjvtynfdwgcgeb
-- captured: 2026-08-04T19:04:17.671Z
-- function: public.is_manager()
-- language: sql   security_definer: true   volatility: s
-- READ-ONLY DUMP. Do not apply this file.
CREATE OR REPLACE FUNCTION public.is_manager()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('manager', 'super_admin')
      and is_active
  );
$function$

