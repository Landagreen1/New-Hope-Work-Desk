-- LIVE definition dumped from Supabase project kfbgftkjvtynfdwgcgeb
-- captured: 2026-08-04T19:04:17.671Z
-- function: public.is_rotation_eligible(p_profile_id uuid, p_rotation rotation_kind)
-- language: sql   security_definer: true   volatility: s
-- READ-ONLY DUMP. Do not apply this file.
CREATE OR REPLACE FUNCTION public.is_rotation_eligible(p_profile_id uuid, p_rotation rotation_kind)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((
    select p.is_active
       and p.role = 'agent'
       and p.availability = 'available'
       and case
         when p_rotation = 'whatsapp'    then p.whatsapp_active
         when p_rotation = 'ringcentral' then p.ringcentral_active
         else                                 p.workload_active
       end
       and case
         when p_rotation = 'whatsapp'    then p.whatsapp_position
         when p_rotation = 'ringcentral' then p.ringcentral_position
         else                                 p.workload_position
       end is not null
    from public.profiles p
    where p.id = p_profile_id
  ), false);
$function$

