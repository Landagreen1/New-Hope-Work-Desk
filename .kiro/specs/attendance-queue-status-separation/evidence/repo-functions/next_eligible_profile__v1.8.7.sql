-- REPO definition extracted from supabase/migrations/v1.8.7-fix-rotation-integrity.sql line 97
-- for comparison against the live dump in ../live-functions/next_eligible_profile.sql

create or replace function public.next_eligible_profile(
  p_rotation public.rotation_kind,
  p_after_position integer
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
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
$$;
