-- New Hope Work Desk v1.8.4
-- Fix RLS: Allow commercial and agent roles to INSERT into cs_intake_submissions.
-- Also fix can_read_cs_intake and can_edit_cs_intake to include commercial roles.
-- The v1.6.2 policy was too restrictive — only allowed CS/manager roles.

-- 1. Fix INSERT policy
drop policy if exists "cs_intake_insert" on public.cs_intake_submissions;

create policy "cs_intake_insert" on public.cs_intake_submissions
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and (
      (select role from public.profiles where id = auth.uid()) in (
        'agent',
        'customer_service',
        'customer_service_supervisor',
        'commercial',
        'commercial_supervisor',
        'sales_supervisor',
        'manager',
        'super_admin'
      )
    )
  );

-- 2. Fix can_read_cs_intake to include commercial roles (can read their own intakes)
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
        public.can_manage_customer_service()
        or (p.role = 'customer_service' and s.created_by = auth.uid())
        or (p.role in ('commercial', 'commercial_supervisor') and s.created_by = auth.uid())
        or (p.role in ('agent', 'sales_supervisor') and s.status::text not in ('draft', 'deleted'))
      )
  );
$$;

-- 3. Fix can_edit_cs_intake to include commercial roles (can edit their own intakes)
create or replace function public.can_edit_cs_intake(p_submission_id uuid)
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
        public.can_manage_customer_service()
        or (p.role = 'customer_service' and s.created_by = auth.uid())
        or (p.role in ('commercial', 'commercial_supervisor') and s.created_by = auth.uid())
      )
  );
$$;
