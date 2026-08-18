-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.17.3 — Allow specialty members to read template PDFs from storage
--
-- The existing storage policy only allows access to paths starting with a valid
-- opportunity UUID. Template PDFs are stored at 'templates/...' which doesn't
-- match. This adds a policy allowing any specialty module member to read files
-- in the templates/ prefix.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Allow reading template files (stored under templates/ prefix)
drop policy if exists specialty_documents_storage_templates_select on storage.objects;
create policy specialty_documents_storage_templates_select
  on storage.objects for select to authenticated
  using (
    bucket_id = 'specialty-quote-documents'
    and name like 'templates/%'
    and public.specialty_can_access()
  );
