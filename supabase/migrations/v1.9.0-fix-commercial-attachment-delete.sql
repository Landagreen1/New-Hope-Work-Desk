-- v1.9.0: Allow commercial agents to delete any attachment on their own cards
-- Previously the delete policy only allowed deleting attachments you uploaded.
-- Commercial agents should be able to manage all attachments on cards assigned to them.

drop policy if exists "commercial_attachments_delete" on public.commercial_quote_attachments;
create policy "commercial_attachments_delete" on public.commercial_quote_attachments
  for delete to authenticated
  using (
    uploaded_by = auth.uid()
    or public.can_manage_commercial()
    or exists (
      select 1 from public.commercial_quotes q
      where q.id = commercial_quote_attachments.quote_id
        and q.assigned_to = auth.uid()
    )
  );

-- Also fix storage delete policy to include commercial_supervisor role
-- (it was missing from the original v1.6.2 migration pattern).
drop policy if exists "commercial_storage_delete" on storage.objects;
create policy "commercial_storage_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'commercial-quote-attachments'
    and (
      (select role from public.profiles where id = auth.uid()) in ('commercial', 'commercial_supervisor')
      or public.can_manage_commercial()
    )
  );
