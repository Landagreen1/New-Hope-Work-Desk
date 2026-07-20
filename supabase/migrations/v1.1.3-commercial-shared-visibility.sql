-- New Hope Work Desk v1.1.3 — Shared visibility for commercial quotes
-- All commercial agents can now SEE all commercial quotes (not just their own).
-- This allows them to leave notes, check prices, and cover for absent colleagues.
-- Cards still belong to their assigned owner (only owner can move/edit fields).
-- Comments track who left them with author_id + timestamp.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Update commercial_quotes SELECT policy: all commercial users can see all cards
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "commercial_agent_select" on public.commercial_quotes;

create policy "commercial_agent_select" on public.commercial_quotes
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'commercial'
  );

-- UPDATE remains restricted to card owner only (unchanged logic)
drop policy if exists "commercial_agent_update" on public.commercial_quotes;

create policy "commercial_agent_update" on public.commercial_quotes
  for update to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) = 'commercial'
    and assigned_to = auth.uid()
  )
  with check (
    (select role from public.profiles where id = auth.uid()) = 'commercial'
    and assigned_to = auth.uid()
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Update comments policies: all commercial users can see and add comments
--    on ANY card (not just their own). Comments track author_id automatically.
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "commercial_comments_select" on public.commercial_quote_comments;

create policy "commercial_comments_select" on public.commercial_quote_comments
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager')
  );

drop policy if exists "commercial_comments_insert" on public.commercial_quote_comments;

create policy "commercial_comments_insert" on public.commercial_quote_comments
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Update attachments SELECT: all commercial users can view attachments
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "commercial_attachments_select" on public.commercial_quote_attachments;

create policy "commercial_attachments_select" on public.commercial_quote_attachments
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Update checklists SELECT: all commercial users can view checklists
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "commercial_checklists_select" on public.commercial_quote_checklists;

create policy "commercial_checklists_select" on public.commercial_quote_checklists
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager')
  );

drop policy if exists "commercial_checklist_items_select" on public.commercial_quote_checklist_items;

create policy "commercial_checklist_items_select" on public.commercial_quote_checklist_items
  for select to authenticated
  using (
    exists (
      select 1 from public.commercial_quote_checklists cl
      where cl.id = commercial_quote_checklist_items.checklist_id
        and (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager')
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Update column history SELECT: all commercial users can view history
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "commercial_column_history_select" on public.commercial_quote_column_history;

create policy "commercial_column_history_select" on public.commercial_quote_column_history
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager')
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. Update activity log SELECT: all commercial users can view activity
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists "commercial_activity_log_select" on public.commercial_quote_activity_log;

create policy "commercial_activity_log_select" on public.commercial_quote_activity_log
  for select to authenticated
  using (
    (select role from public.profiles where id = auth.uid()) in ('commercial', 'manager')
  );

commit;

select 'Commercial shared visibility policies updated' as status;
