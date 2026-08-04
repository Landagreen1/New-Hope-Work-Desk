-- LIVE definition dumped from Supabase project kfbgftkjvtynfdwgcgeb
-- captured: 2026-08-04T19:04:17.672Z
-- function: public.next_eligible_profile(p_rotation rotation_kind, p_after_position integer)
-- language: sql   security_definer: true   volatility: s
-- READ-ONLY DUMP. Do not apply this file.
CREATE OR REPLACE FUNCTION public.next_eligible_profile(p_rotation rotation_kind, p_after_position integer)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.id
  from public.profiles p
  where p.is_active
    and p.role = 'agent'
    and p.availability = 'available'
    and case
      when p_rotation = 'whatsapp'    then p.whatsapp_active
      when p_rotation = 'ringcentral' then p.ringcentral_active
      else                                 p.workload_active
    end
    -- RC-5: an agent with no position for this rotation is not eligible.
    and case
      when p_rotation = 'whatsapp'    then p.whatsapp_position
      when p_rotation = 'ringcentral' then p.ringcentral_position
      else                                 p.workload_position
    end is not null
  order by
    -- RC-1: wraparound belongs in ORDER BY, never in WHERE.
    -- Bucket 0 = "after the current position", bucket 1 = "wrapped around".
    -- When p_after_position is null the comparison yields null (not true), so
    -- every row lands in bucket 1 and the lowest position wins.
    case
      when (case
              when p_rotation = 'whatsapp'    then p.whatsapp_position
              when p_rotation = 'ringcentral' then p.ringcentral_position
              else                                 p.workload_position
            end) > p_after_position
      then 0 else 1
    end,
    case
      when p_rotation = 'whatsapp'    then p.whatsapp_position
      when p_rotation = 'ringcentral' then p.ringcentral_position
      else                                 p.workload_position
    end,
    p.id                                  -- RC-5: deterministic tiebreaker
  limit 1;
$function$

