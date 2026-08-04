-- REPO definition extracted from supabase/migrations/v1.8.7-fix-rotation-integrity.sql line 151
-- for comparison against the live dump in ../live-functions/is_rotation_eligible.sql

create or replace function public.is_rotation_eligible(
  p_profile_id uuid,
  p_rotation public.rotation_kind
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
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
$$;
