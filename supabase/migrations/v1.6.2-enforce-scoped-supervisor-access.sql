-- v1.6.2 — Enforce department-scoped supervisor access
-- Requires v1.6.1 to be committed first.

begin;

-- Broad manager remains intentionally broad-manager only.
create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('manager', 'super_admin')
      and is_active
  );
$$;

create or replace function public.can_manage_sales()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('manager', 'sales_supervisor', 'super_admin')
      and is_active
  );
$$;

create or replace function public.can_manage_customer_service()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('manager', 'customer_service_supervisor', 'super_admin')
      and is_active
  );
$$;

create or replace function public.can_manage_commercial()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('manager', 'commercial_supervisor', 'super_admin')
      and is_active
  );
$$;

-- Preserve super-admin parity without collapsing scoped supervisors into manager.
create or replace function public.nhwd_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when role = 'super_admin' then 'manager' else role::text end
  from public.profiles
  where id = auth.uid() and is_active
$$;

grant execute on function public.can_manage_sales() to authenticated;
grant execute on function public.can_manage_customer_service() to authenticated;
grant execute on function public.can_manage_commercial() to authenticated;

-- Sales manager RPCs: replace only sales-domain broad-manager gates.
do $sales_functions$
declare
  v_proc record;
  v_source text;
  v_updated text;
begin
  for v_proc in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        p.proname like 'manager_%'
        or p.proname in (
          'finalize_pending_pricing_quote',
          'change_quote_outcome',
          'log_manual_workload'
        )
      )
  loop
    v_source := pg_get_functiondef(v_proc.oid);
    v_updated := replace(v_source, 'public.is_manager()', 'public.can_manage_sales()');
    if v_updated is distinct from v_source then execute v_updated; end if;
  end loop;
end
$sales_functions$;

-- Older operational-quote RPCs use direct role checks instead of is_manager().
do $legacy_sales_functions$
declare
  v_proc record;
  v_source text;
  v_updated text;
begin
  for v_proc in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('merge_quote_records', 'resolve_quote_duplicate')
  loop
    v_source := pg_get_functiondef(v_proc.oid);
    v_updated := regexp_replace(
      v_source,
      'v_caller\.role\s+NOT\s+IN\s*\([^;\n]*manager[^;\n]*\)',
      'not public.can_manage_sales()',
      'gi'
    );
    v_updated := regexp_replace(
      v_updated,
      'v_caller\.role\s*(<>|!=)\s*''manager''',
      'not public.can_manage_sales()',
      'gi'
    );
    if v_updated is distinct from v_source then execute v_updated; end if;
  end loop;

  for v_proc in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'flag_quote_duplicate'
  loop
    v_source := pg_get_functiondef(v_proc.oid);
    v_updated := regexp_replace(
      v_source,
      'v_caller\.role\s+NOT\s+IN\s*\([^;\n]*agent[^;\n]*\)',
      'not (v_caller.role = ''agent'' or public.can_manage_sales())',
      'gi'
    );
    v_updated := regexp_replace(
      v_updated,
      'where role = ''manager'' and is_active = true',
      'where role in (''manager'', ''sales_supervisor'', ''super_admin'') and is_active = true',
      'gi'
    );
    if v_updated is distinct from v_source then execute v_updated; end if;
  end loop;
end
$legacy_sales_functions$;

-- Integrated CS RPCs: manager operations are available to CS supervisors only.
do $cs_functions$
declare
  v_proc record;
  v_source text;
  v_updated text;
begin
  for v_proc in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'cs_intake_manager_assign',
        'cs_intake_return',
        'cs_intake_convert',
        'cs_intake_submit',
        'cs_intake_submit_commercial',
        'delete_customer_intake',
        'restore_customer_intake',
        'update_customer_intake',
        'assign_customer_intake'
      )
  loop
    v_source := pg_get_functiondef(v_proc.oid);
    v_updated := regexp_replace(
      v_source,
      'public\.nhwd_role\(\)\s*<>\s*''manager''',
      'not public.can_manage_customer_service()',
      'gi'
    );
    v_updated := regexp_replace(
      v_updated,
      'public\.nhwd_role\(\)\s*=\s*''manager''',
      'public.can_manage_customer_service()',
      'gi'
    );
    v_updated := regexp_replace(
      v_updated,
      'v_caller\.role\s+NOT\s+IN\s*\([^;\n]*manager[^;\n]*\)',
      'not public.can_manage_customer_service()',
      'gi'
    );
    v_updated := regexp_replace(
      v_updated,
      'v_caller\.role(::text)?\s*(<>|!=)\s*''manager''',
      'not public.can_manage_customer_service()',
      'gi'
    );
    v_updated := regexp_replace(
      v_updated,
      'v_caller\.role::text\s+IN\s*\([^;\n]*manager[^;\n]*\)',
      'public.can_manage_customer_service()',
      'gi'
    );
    -- Fix broken CASE expressions where regex removed the THEN clause.
    -- The original pattern was: case when nhwd_role() = 'manager' then p_reason else null end
    -- After regex it became:    case when public.can_manage_customer_service() else null end
    v_updated := replace(
      v_updated,
      'case when public.can_manage_customer_service() else null end',
      'case when public.can_manage_customer_service() then p_reason else null end'
    );
    v_updated := replace(
      v_updated,
      'case when not public.can_manage_customer_service() else null end',
      'case when public.can_manage_customer_service() then p_reason else null end'
    );
    if v_updated is distinct from v_source then execute v_updated; end if;
  end loop;
end
$cs_functions$;

-- Commercial: members share visibility; commercial supervisors get manager actions.
drop policy if exists "manager_commercial_all" on public.commercial_quotes;
create policy "manager_commercial_all" on public.commercial_quotes
  for all to authenticated
  using (public.can_manage_commercial())
  with check (public.can_manage_commercial());

-- Related commercial records inherit the same department boundary.
drop policy if exists "manager_comments_all" on public.commercial_quote_comments;
create policy "manager_comments_all" on public.commercial_quote_comments
  for all to authenticated
  using (public.can_manage_commercial())
  with check (public.can_manage_commercial());

drop policy if exists "commercial_comments_select" on public.commercial_quote_comments;
create policy "commercial_comments_select" on public.commercial_quote_comments
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'commercial'
    or public.can_manage_commercial()
  );

drop policy if exists "commercial_comments_insert" on public.commercial_quote_comments;
create policy "commercial_comments_insert" on public.commercial_quote_comments
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and (
      (select role from public.profiles where id = auth.uid()) = 'commercial'
      or public.can_manage_commercial()
    )
  );

drop policy if exists "commercial_attachments_select" on public.commercial_quote_attachments;
create policy "commercial_attachments_select" on public.commercial_quote_attachments
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'commercial'
    or public.can_manage_commercial()
  );

drop policy if exists "commercial_attachments_insert" on public.commercial_quote_attachments;
create policy "commercial_attachments_insert" on public.commercial_quote_attachments
  for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and (
      (select role from public.profiles where id = auth.uid()) = 'commercial'
      or public.can_manage_commercial()
    )
  );

drop policy if exists "commercial_attachments_delete" on public.commercial_quote_attachments;
create policy "commercial_attachments_delete" on public.commercial_quote_attachments
  for delete to authenticated
  using (uploaded_by = auth.uid() or public.can_manage_commercial());

drop policy if exists "commercial_checklists_select" on public.commercial_quote_checklists;
create policy "commercial_checklists_select" on public.commercial_quote_checklists
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'commercial'
    or public.can_manage_commercial()
  );

drop policy if exists "commercial_checklists_insert" on public.commercial_quote_checklists;
create policy "commercial_checklists_insert" on public.commercial_quote_checklists
  for insert to authenticated
  with check (
    exists (
      select 1 from public.commercial_quotes q
      where q.id = commercial_quote_checklists.quote_id
        and (q.assigned_to = auth.uid() or public.can_manage_commercial())
    )
  );

drop policy if exists "commercial_checklists_delete" on public.commercial_quote_checklists;
create policy "commercial_checklists_delete" on public.commercial_quote_checklists
  for delete to authenticated
  using (
    exists (
      select 1 from public.commercial_quotes q
      where q.id = commercial_quote_checklists.quote_id
        and (q.assigned_to = auth.uid() or public.can_manage_commercial())
    )
  );

drop policy if exists "commercial_checklist_items_select" on public.commercial_quote_checklist_items;
create policy "commercial_checklist_items_select" on public.commercial_quote_checklist_items
  for select to authenticated
  using (
    exists (
      select 1 from public.commercial_quote_checklists c
      where c.id = commercial_quote_checklist_items.checklist_id
    )
  );

drop policy if exists "commercial_checklist_items_insert" on public.commercial_quote_checklist_items;
create policy "commercial_checklist_items_insert" on public.commercial_quote_checklist_items
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.commercial_quote_checklists c
      join public.commercial_quotes q on q.id = c.quote_id
      where c.id = commercial_quote_checklist_items.checklist_id
        and (q.assigned_to = auth.uid() or public.can_manage_commercial())
    )
  );

drop policy if exists "commercial_checklist_items_update" on public.commercial_quote_checklist_items;
create policy "commercial_checklist_items_update" on public.commercial_quote_checklist_items
  for update to authenticated
  using (
    exists (
      select 1
      from public.commercial_quote_checklists c
      join public.commercial_quotes q on q.id = c.quote_id
      where c.id = commercial_quote_checklist_items.checklist_id
        and (q.assigned_to = auth.uid() or public.can_manage_commercial())
    )
  )
  with check (
    exists (
      select 1
      from public.commercial_quote_checklists c
      join public.commercial_quotes q on q.id = c.quote_id
      where c.id = commercial_quote_checklist_items.checklist_id
        and (q.assigned_to = auth.uid() or public.can_manage_commercial())
    )
  );

drop policy if exists "commercial_checklist_items_delete" on public.commercial_quote_checklist_items;
create policy "commercial_checklist_items_delete" on public.commercial_quote_checklist_items
  for delete to authenticated
  using (
    exists (
      select 1
      from public.commercial_quote_checklists c
      join public.commercial_quotes q on q.id = c.quote_id
      where c.id = commercial_quote_checklist_items.checklist_id
        and (q.assigned_to = auth.uid() or public.can_manage_commercial())
    )
  );

drop policy if exists "commercial_column_history_select" on public.commercial_quote_column_history;
create policy "commercial_column_history_select" on public.commercial_quote_column_history
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'commercial'
    or public.can_manage_commercial()
  );

drop policy if exists "commercial_column_history_insert" on public.commercial_quote_column_history;
create policy "commercial_column_history_insert" on public.commercial_quote_column_history
  for insert to authenticated
  with check (
    moved_by = auth.uid()
    and (
      (select role from public.profiles where id = auth.uid()) = 'commercial'
      or public.can_manage_commercial()
    )
  );

drop policy if exists "commercial_activity_log_select" on public.commercial_quote_activity_log;
create policy "commercial_activity_log_select" on public.commercial_quote_activity_log
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'commercial'
    or public.can_manage_commercial()
  );

drop policy if exists "commercial_activity_log_insert" on public.commercial_quote_activity_log;
create policy "commercial_activity_log_insert" on public.commercial_quote_activity_log
  for insert to authenticated
  with check (
    actor_id = auth.uid()
    and (
      (select role from public.profiles where id = auth.uid()) = 'commercial'
      or public.can_manage_commercial()
    )
  );

drop policy if exists "commercial_storage_select" on storage.objects;
create policy "commercial_storage_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'commercial-quote-attachments'
    and (
      (select role from public.profiles where id = auth.uid()) = 'commercial'
      or public.can_manage_commercial()
    )
  );

drop policy if exists "commercial_storage_insert" on storage.objects;
create policy "commercial_storage_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'commercial-quote-attachments'
    and (
      (select role from public.profiles where id = auth.uid()) = 'commercial'
      or public.can_manage_commercial()
    )
  );

drop policy if exists "commercial_storage_delete" on storage.objects;
create policy "commercial_storage_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'commercial-quote-attachments'
    and (
      (select role from public.profiles where id = auth.uid()) = 'commercial'
      or public.can_manage_commercial()
    )
  );

-- Operational Sales quotes and duplicate review are Sales-supervisor scope.
drop policy if exists "manager_all_quotes" on public.operational_quotes;
create policy "manager_all_quotes" on public.operational_quotes
  for all to authenticated
  using (public.can_manage_sales())
  with check (public.can_manage_sales());

drop policy if exists "manager_all_reviews" on public.duplicate_reviews;
create policy "manager_all_reviews" on public.duplicate_reviews
  for select to authenticated
  using (public.can_manage_sales());

drop policy if exists "manager_update_review" on public.duplicate_reviews;
create policy "manager_update_review" on public.duplicate_reviews
  for update to authenticated
  using (public.can_manage_sales())
  with check (public.can_manage_sales());

-- Legacy intake management belongs to Customer Service supervisors.
drop policy if exists "manager_select_all" on public.customer_intakes;
create policy "manager_select_all" on public.customer_intakes
  for select to authenticated
  using (public.can_manage_customer_service());

drop policy if exists "manager_update_all" on public.customer_intakes;
create policy "manager_update_all" on public.customer_intakes
  for update to authenticated
  using (public.can_manage_customer_service())
  with check (public.can_manage_customer_service());

-- Restore RLS on the integrated CS intake tables (disabled by v1.1.1).
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
        or (p.role in ('agent', 'sales_supervisor') and s.status::text not in ('draft', 'deleted'))
      )
  );
$$;

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
      )
  );
$$;

grant execute on function public.can_read_cs_intake(uuid) to authenticated;
grant execute on function public.can_edit_cs_intake(uuid) to authenticated;

alter table public.cs_intake_submissions enable row level security;
drop policy if exists "cs_intake_select_all" on public.cs_intake_submissions;
drop policy if exists "cs_intake_insert" on public.cs_intake_submissions;
drop policy if exists "cs_intake_update" on public.cs_intake_submissions;
drop policy if exists "cs_intake_delete" on public.cs_intake_submissions;

create policy "cs_intake_select_all" on public.cs_intake_submissions
  for select to authenticated
  using (public.can_read_cs_intake(id));

create policy "cs_intake_insert" on public.cs_intake_submissions
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and (
      (select role from public.profiles where id = auth.uid()) in ('customer_service', 'customer_service_supervisor', 'manager', 'super_admin')
    )
  );

create policy "cs_intake_update" on public.cs_intake_submissions
  for update to authenticated
  using (public.can_edit_cs_intake(id))
  with check (public.can_edit_cs_intake(id));

create policy "cs_intake_delete" on public.cs_intake_submissions
  for delete to authenticated
  using (public.can_manage_customer_service());

alter table public.cs_intake_drivers enable row level security;
drop policy if exists "cs_intake_drivers_select" on public.cs_intake_drivers;
drop policy if exists "cs_intake_drivers_insert" on public.cs_intake_drivers;
drop policy if exists "cs_intake_drivers_update" on public.cs_intake_drivers;
drop policy if exists "cs_intake_drivers_delete" on public.cs_intake_drivers;
create policy "cs_intake_drivers_select" on public.cs_intake_drivers for select to authenticated using (public.can_read_cs_intake(submission_id));
create policy "cs_intake_drivers_insert" on public.cs_intake_drivers for insert to authenticated with check (public.can_edit_cs_intake(submission_id));
create policy "cs_intake_drivers_update" on public.cs_intake_drivers for update to authenticated using (public.can_edit_cs_intake(submission_id)) with check (public.can_edit_cs_intake(submission_id));
create policy "cs_intake_drivers_delete" on public.cs_intake_drivers for delete to authenticated using (public.can_edit_cs_intake(submission_id));

alter table public.cs_intake_vehicles enable row level security;
drop policy if exists "cs_intake_vehicles_select" on public.cs_intake_vehicles;
drop policy if exists "cs_intake_vehicles_insert" on public.cs_intake_vehicles;
drop policy if exists "cs_intake_vehicles_update" on public.cs_intake_vehicles;
drop policy if exists "cs_intake_vehicles_delete" on public.cs_intake_vehicles;
create policy "cs_intake_vehicles_select" on public.cs_intake_vehicles for select to authenticated using (public.can_read_cs_intake(submission_id));
create policy "cs_intake_vehicles_insert" on public.cs_intake_vehicles for insert to authenticated with check (public.can_edit_cs_intake(submission_id));
create policy "cs_intake_vehicles_update" on public.cs_intake_vehicles for update to authenticated using (public.can_edit_cs_intake(submission_id)) with check (public.can_edit_cs_intake(submission_id));
create policy "cs_intake_vehicles_delete" on public.cs_intake_vehicles for delete to authenticated using (public.can_edit_cs_intake(submission_id));

alter table public.cs_intake_events enable row level security;
drop policy if exists "cs_intake_events_select" on public.cs_intake_events;
drop policy if exists "cs_intake_events_insert" on public.cs_intake_events;
create policy "cs_intake_events_select" on public.cs_intake_events for select to authenticated using (public.can_read_cs_intake(submission_id));
create policy "cs_intake_events_insert" on public.cs_intake_events for insert to authenticated with check (actor_id = auth.uid() and public.can_edit_cs_intake(submission_id));

-- All roles are employees in Time & Attendance; only Super Admin administers it.
drop policy if exists "time_clock_own_select" on public.time_clock_entries;
drop policy if exists "time_clock_own_insert" on public.time_clock_entries;
drop policy if exists "time_clock_own_update" on public.time_clock_entries;
drop policy if exists "time_clock_select" on public.time_clock_entries;
drop policy if exists "time_clock_insert" on public.time_clock_entries;
drop policy if exists "time_clock_update" on public.time_clock_entries;
drop policy if exists "time_clock_manager_all" on public.time_clock_entries;
drop policy if exists "time_clock_admin_all" on public.time_clock_entries;
create policy "time_clock_select" on public.time_clock_entries for select to authenticated using (profile_id = auth.uid() or (select role from public.profiles where id = auth.uid()) = 'super_admin');
create policy "time_clock_insert" on public.time_clock_entries for insert to authenticated with check (profile_id = auth.uid());
create policy "time_clock_update" on public.time_clock_entries for update to authenticated using (profile_id = auth.uid()) with check (profile_id = auth.uid());
create policy "time_clock_admin_all" on public.time_clock_entries for all to authenticated using ((select role from public.profiles where id = auth.uid()) = 'super_admin') with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

drop policy if exists "time_clock_breaks_select" on public.time_clock_breaks;
drop policy if exists "time_clock_breaks_insert" on public.time_clock_breaks;
drop policy if exists "time_clock_breaks_update" on public.time_clock_breaks;
drop policy if exists "time_clock_breaks_manager_all" on public.time_clock_breaks;
drop policy if exists "time_clock_breaks_admin_all" on public.time_clock_breaks;
create policy "time_clock_breaks_select" on public.time_clock_breaks for select to authenticated using (exists (select 1 from public.time_clock_entries e where e.id = time_clock_breaks.clock_entry_id and (e.profile_id = auth.uid() or (select role from public.profiles where id = auth.uid()) = 'super_admin')));
create policy "time_clock_breaks_insert" on public.time_clock_breaks for insert to authenticated with check (exists (select 1 from public.time_clock_entries e where e.id = time_clock_breaks.clock_entry_id and e.profile_id = auth.uid()));
create policy "time_clock_breaks_update" on public.time_clock_breaks for update to authenticated using (exists (select 1 from public.time_clock_entries e where e.id = time_clock_breaks.clock_entry_id and e.profile_id = auth.uid())) with check (exists (select 1 from public.time_clock_entries e where e.id = time_clock_breaks.clock_entry_id and e.profile_id = auth.uid()));
create policy "time_clock_breaks_admin_all" on public.time_clock_breaks for all to authenticated using ((select role from public.profiles where id = auth.uid()) = 'super_admin') with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

drop policy if exists "schedules_select" on public.employee_schedules;
drop policy if exists "schedules_manager_all" on public.employee_schedules;
drop policy if exists "schedules_insert" on public.employee_schedules;
drop policy if exists "schedules_update" on public.employee_schedules;
drop policy if exists "schedules_admin_all" on public.employee_schedules;
create policy "schedules_select" on public.employee_schedules for select to authenticated using (profile_id = auth.uid() or (select role from public.profiles where id = auth.uid()) = 'super_admin');
create policy "schedules_admin_all" on public.employee_schedules for all to authenticated using ((select role from public.profiles where id = auth.uid()) = 'super_admin') with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

drop policy if exists "pto_own_select" on public.pto_requests;
drop policy if exists "pto_own_insert" on public.pto_requests;
drop policy if exists "pto_own_update" on public.pto_requests;
drop policy if exists "pto_requests_select" on public.pto_requests;
drop policy if exists "pto_requests_insert" on public.pto_requests;
drop policy if exists "pto_requests_update" on public.pto_requests;
drop policy if exists "pto_requests_manager_all" on public.pto_requests;
drop policy if exists "pto_requests_admin_all" on public.pto_requests;
create policy "pto_requests_select" on public.pto_requests for select to authenticated using (profile_id = auth.uid() or (select role from public.profiles where id = auth.uid()) = 'super_admin');
create policy "pto_requests_insert" on public.pto_requests for insert to authenticated with check (profile_id = auth.uid());
create policy "pto_requests_update" on public.pto_requests for update to authenticated using (profile_id = auth.uid() and status = 'pending') with check (profile_id = auth.uid());
create policy "pto_requests_admin_all" on public.pto_requests for all to authenticated using ((select role from public.profiles where id = auth.uid()) = 'super_admin') with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

drop policy if exists "pto_balances_select" on public.pto_balances;
drop policy if exists "pto_balances_manager_all" on public.pto_balances;
drop policy if exists "pto_balances_admin_all" on public.pto_balances;
create policy "pto_balances_select" on public.pto_balances for select to authenticated using (profile_id = auth.uid() or (select role from public.profiles where id = auth.uid()) = 'super_admin');
create policy "pto_balances_admin_all" on public.pto_balances for all to authenticated using ((select role from public.profiles where id = auth.uid()) = 'super_admin') with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

drop policy if exists "payroll_periods_select" on public.payroll_periods;
drop policy if exists "payroll_periods_manager_all" on public.payroll_periods;
drop policy if exists "payroll_periods_manage" on public.payroll_periods;
drop policy if exists "payroll_periods_admin_all" on public.payroll_periods;
create policy "payroll_periods_admin_all" on public.payroll_periods for all to authenticated using ((select role from public.profiles where id = auth.uid()) = 'super_admin') with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

drop policy if exists "payroll_summaries_select" on public.payroll_summaries;
drop policy if exists "payroll_summaries_manager_all" on public.payroll_summaries;
drop policy if exists "payroll_summaries_manage" on public.payroll_summaries;
drop policy if exists "payroll_summaries_admin_all" on public.payroll_summaries;
create policy "payroll_summaries_admin_all" on public.payroll_summaries for all to authenticated using ((select role from public.profiles where id = auth.uid()) = 'super_admin') with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

drop policy if exists "payment_settings_select" on public.employee_payment_settings;
drop policy if exists "payment_settings_manager_all" on public.employee_payment_settings;
drop policy if exists "payment_settings_upsert" on public.employee_payment_settings;
drop policy if exists "payment_settings_update" on public.employee_payment_settings;
drop policy if exists "payment_settings_admin_all" on public.employee_payment_settings;
create policy "payment_settings_admin_all" on public.employee_payment_settings for all to authenticated using ((select role from public.profiles where id = auth.uid()) = 'super_admin') with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

drop policy if exists "staffing_thresholds_select" on public.staffing_thresholds;
drop policy if exists "staffing_thresholds_manager_all" on public.staffing_thresholds;
drop policy if exists "staffing_thresholds_manage" on public.staffing_thresholds;
drop policy if exists "staffing_thresholds_admin_all" on public.staffing_thresholds;
create policy "staffing_thresholds_admin_all" on public.staffing_thresholds for all to authenticated using ((select role from public.profiles where id = auth.uid()) = 'super_admin') with check ((select role from public.profiles where id = auth.uid()) = 'super_admin');

commit;

select 'Scoped supervisor access enforced' as status;
