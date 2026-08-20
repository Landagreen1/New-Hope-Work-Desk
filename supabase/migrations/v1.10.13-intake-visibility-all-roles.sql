-- New Hope Work Desk v1.10.13
-- Fix: Grant full intake visibility to customer_service and commercial roles.
-- Previously these roles could only see their OWN intakes (created_by = auth.uid()).
-- Now they can see all non-draft/non-deleted intakes, same as agents/sales_supervisors.
-- This allows CS to follow up on intakes and sales agents to claim them.

create or replace function public.can_read_cs_intake(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.cs_intake_submissions s
    join public.profiles p on p.id = auth.uid() and p.is_active
    where s.id = p_submission_id
      and (
        -- Managers, CS supervisors, super_admins see everything
        public.can_manage_customer_service()
        -- All operational roles see non-draft/non-deleted intakes
        or (
          p.role in ('agent', 'sales_supervisor', 'customer_service', 'customer_service_supervisor', 'commercial', 'commercial_supervisor')
          and s.status::text not in ('draft', 'deleted')
        )
      )
  );
$$;
