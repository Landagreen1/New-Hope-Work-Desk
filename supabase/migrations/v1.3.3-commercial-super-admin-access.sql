-- New Hope Work Desk v1.3.3 — Grant super_admin full access to commercial quotes
-- The super_admin role inherits all manager permissions per system rules.
-- Previously, RLS policies only checked for role = 'manager'.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. commercial_quotes: update manager policy to include super_admin
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "manager_commercial_all" on public.commercial_quotes;

create policy "manager_commercial_all" on public.commercial_quotes
  for all to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  )
  with check (
    (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. commercial_quote_comments: update policies
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "commercial_comments_select" on public.commercial_quote_comments;

create policy "commercial_comments_select" on public.commercial_quote_comments
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager', 'super_admin')
  );

drop policy if exists "commercial_comments_insert" on public.commercial_quote_comments;

create policy "commercial_comments_insert" on public.commercial_quote_comments
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. commercial_quote_attachments: update select policy
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "commercial_attachments_select" on public.commercial_quote_attachments;

create policy "commercial_attachments_select" on public.commercial_quote_attachments
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. commercial_quote_checklists: update select policies
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "commercial_checklists_select" on public.commercial_quote_checklists;

create policy "commercial_checklists_select" on public.commercial_quote_checklists
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager', 'super_admin')
  );

drop policy if exists "commercial_checklist_items_select" on public.commercial_quote_checklist_items;

create policy "commercial_checklist_items_select" on public.commercial_quote_checklist_items
  for select to authenticated
  using (
    exists (
      select 1 from public.commercial_quote_checklists cl
      where cl.id = commercial_quote_checklist_items.checklist_id
        and (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager', 'super_admin')
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. commercial_quote_column_history: update select policy
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "commercial_column_history_select" on public.commercial_quote_column_history;

create policy "commercial_column_history_select" on public.commercial_quote_column_history
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager', 'super_admin')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. commercial_quote_activity_log: update select policy
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "commercial_activity_log_select" on public.commercial_quote_activity_log;

create policy "commercial_activity_log_select" on public.commercial_quote_activity_log
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager', 'super_admin')
  );

commit;

select 'Super admin commercial access policies applied' as status;
