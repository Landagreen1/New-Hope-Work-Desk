CREATE OR REPLACE FUNCTION public.next_eligible_profile(p_rotation rotation_kind, p_after_position integer)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT p.id
  FROM public.profiles p
  WHERE p.is_active
    AND p.role = 'agent'
    AND p.availability = 'available'
    AND CASE
      WHEN p_rotation = 'whatsapp' THEN p.whatsapp_active
      WHEN p_rotation = 'ringcentral' THEN p.ringcentral_active
      ELSE p.workload_active
    END
    AND CASE
      WHEN p_rotation = 'whatsapp' THEN p.whatsapp_position > p_after_position
      WHEN p_rotation = 'ringcentral' THEN p.ringcentral_position > p_after_position
      ELSE p.workload_position > p_after_position
    END
  ORDER BY
    CASE
      WHEN p_rotation = 'whatsapp' THEN p.whatsapp_position
      WHEN p_rotation = 'ringcentral' THEN p.ringcentral_position
      ELSE p.workload_position
    END
  LIMIT 1;
$function$

