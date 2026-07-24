-- Fix commercial checklist INSERT/DELETE/UPDATE policies to include super_admin
-- Previously only 'manager' and card-owner 'commercial' could write checklists.

begin;

-- Checklists INSERT
drop policy if exists "commercial_checklists_insert" on public.commercial_quote_checklists;
create policy "commercial_checklists_insert" on public.commercial_quote_checklists
  for insert to authenticated
  with check (
    exists (
      select 1 from public.commercial_quotes cq
      where cq.id = commercial_quote_checklists.quote_id
        and (
          cq.assigned_to = auth.uid()
          or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
        )
    )
  );

-- Checklists DELETE
drop policy if exists "commercial_checklists_delete" on public.commercial_quote_checklists;
create policy "commercial_checklists_delete" on public.commercial_quote_checklists
  for delete to authenticated
  using (
    exists (
      select 1 from public.commercial_quotes cq
      where cq.id = commercial_quote_checklists.quote_id
        and (
          cq.assigned_to = auth.uid()
          or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
        )
    )
  );

-- Checklist Items INSERT
drop policy if exists "commercial_checklist_items_insert" on public.commercial_quote_checklist_items;
create policy "commercial_checklist_items_insert" on public.commercial_quote_checklist_items
  for insert to authenticated
  with check (
    exists (
      select 1 from public.commercial_quote_checklists cl
      join public.commercial_quotes cq on cq.id = cl.quote_id
      where cl.id = commercial_quote_checklist_items.checklist_id
        and (
          cq.assigned_to = auth.uid()
          or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
        )
    )
  );

-- Checklist Items UPDATE (toggle checked)
drop policy if exists "commercial_checklist_items_update" on public.commercial_quote_checklist_items;
create policy "commercial_checklist_items_update" on public.commercial_quote_checklist_items
  for update to authenticated
  using (
    exists (
      select 1 from public.commercial_quote_checklists cl
      join public.commercial_quotes cq on cq.id = cl.quote_id
      where cl.id = commercial_quote_checklist_items.checklist_id
        and (
          cq.assigned_to = auth.uid()
          or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
        )
    )
  )
  with check (
    exists (
      select 1 from public.commercial_quote_checklists cl
      join public.commercial_quotes cq on cq.id = cl.quote_id
      where cl.id = commercial_quote_checklist_items.checklist_id
        and (
          cq.assigned_to = auth.uid()
          or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
        )
    )
  );

-- Checklist Items DELETE
drop policy if exists "commercial_checklist_items_delete" on public.commercial_quote_checklist_items;
create policy "commercial_checklist_items_delete" on public.commercial_quote_checklist_items
  for delete to authenticated
  using (
    exists (
      select 1 from public.commercial_quote_checklists cl
      join public.commercial_quotes cq on cq.id = cl.quote_id
      where cl.id = commercial_quote_checklist_items.checklist_id
        and (
          cq.assigned_to = auth.uid()
          or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
        )
    )
  );

commit;
select 'Checklist policies fixed for super_admin and card owners' as status;


-- Also add 'price_sent' to the card_status CHECK constraint
alter table public.commercial_quotes drop constraint if exists commercial_quotes_card_status_check;
alter table public.commercial_quotes add constraint commercial_quotes_card_status_check
  check (card_status in ('in_progress', 'price_sent', 'done', 'blocked', 'waiting'));
