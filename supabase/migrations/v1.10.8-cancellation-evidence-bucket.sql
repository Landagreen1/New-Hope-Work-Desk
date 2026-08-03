-- New Hope Work Desk v1.10.8 — Cancellation evidence bucket (migration stage 9 of 10)
--
-- Spec: .kiro/specs/policy-follow-up-renewals-cancellations (task 7.9)
-- Requirements: 17.9, 18.6, 18.10, 19.9 (and 26.1, 26.2 for the forward-only rules)
--
-- Forward-only, ninth file of the v1.10.x series. Creates one private storage bucket,
-- one access-test function, and two policies on storage.objects. Touches no table,
-- column, policy, function, or row created at v1.9.7 or earlier: nothing outside the
-- new `cancellation-evidence` bucket, public.cancellation_can_access_evidence(), and the
-- two cancellation_evidence_v1108_* policies is created, read for anything other than
-- assertion, written, altered, dropped, or truncated (Requirements 26.1, 26.2). The only
-- drops anywhere in this file are `drop policy if exists` on the two policy names this
-- file itself creates, plus the rollback path below, which names only this file's objects.
--
-- Contents:
--   0. Baseline capture of the pre-existing renewal-contact-evidence bucket and of every
--      storage.objects policy that targets it, compared again in the post-conditions as
--      live proof that this file left the v0.9.x renewal evidence surface untouched
--   1. The `cancellation-evidence` bucket: private, 100 MiB, no MIME restriction
--   2. public.cancellation_can_access_evidence(text) — the per-object access test
--   3. Two policies on storage.objects: select (so a signed URL can be issued) and
--      insert (so evidence can be uploaded). No update policy, no delete policy.
--   4. Post-conditions, including live proof of every branch of the access test under a
--      simulated session for each role, and proof that the renewal surface is unchanged
--
-- WHY THE POLICIES IN THIS FILE ARE NOT TASK 7.7's
--   v1.10.6-cancellation-rls.sql (task 7.7) owns `enable row level security` and every
--   policy on the public.cancellation_* TABLES. The policies below sit on
--   storage.objects, which is not a cancellation_* table and is not owned by this spec at
--   all, so they cannot be deferred to that file: the bucket created here would otherwise
--   be readable and writable by every authenticated session for as long as it existed
--   without them. Bucket and policies therefore land together, in one transaction.
--   Nothing here enables or disables row level security on storage.objects — Supabase
--   ships that table with row level security already on, which is why adding a bucket
--   with no policy denies every client rather than allowing every client.
--
-- WHAT EACH POLICY PERMITS
--   cancellation_evidence_v1108_select  to authenticated, for select:
--     read an object in `cancellation-evidence` whose first path segment names a
--     Cancellation_Case the caller may read. This is what lets the drawer issue a signed
--     URL and download evidence recorded against a note, a payment report, or a
--     verification outcome (Requirements 17.1, 17.9, 18.6, 19.9). Storage checks this
--     policy when the signed URL is CREATED; the signed URL itself then carries its own
--     time-limited authorization, which is why no public read is needed and none is given.
--   cancellation_evidence_v1108_insert  to authenticated, for insert:
--     upload an object under that same first-path-segment rule (Requirements 17.9, 18.6,
--     19.9). Task 7.9 fixes the insert scope as "readable cases", matching the renewal
--     precedent where select and insert share one predicate; the tighter "own cases"
--     rule of the design's RLS table governs the note / payment report / verification
--     outcome ROW that records the evidence, and that row is task 7.7's to police.
--   NO update policy: an uploaded evidence object cannot be overwritten in place, so an
--     upload with upsert = true fails by design and a second file has to be a second
--     object. Evidence attached to an audit trail must not be silently replaced.
--   NO delete policy: task 7.9 states it, and it matches the append-only stance of the
--     module (Requirement 22.8). Note this is stricter than renewal-contact-evidence,
--     which does carry a manager delete policy. Removing an object therefore needs the
--     service role, which is a deliberate, server-side, auditable act.
--   No policy is created for anon, and no policy is created for `public`.
--
-- ACCESS SCOPE, AND WHY IT IS THE CASE READ SCOPE
--   public.cancellation_can_access_evidence(name) reads the first path segment as a
--   Cancellation_Case id and answers true when the case exists AND
--     * public.cancellation_can_read_all() is true — manager, super_admin,
--       customer_service, sales_supervisor (Requirements 22.1, 22.12); or
--     * the case is assigned to the caller; or
--     * the case is unassigned.
--   That is the design's `cancellation_cases` read scope, verbatim, so evidence
--   visibility can never diverge from case visibility: an agent who can open a case in
--   the drawer can see its evidence, and an agent who cannot open the case cannot reach
--   its evidence even with the exact object path. The unassigned branch is deliberate —
--   the design gives Agent_Role `assigned_to = auth.uid() or assigned_to is null`, and an
--   agent who can open an unassigned case must be able to read what is attached to it
--   (Requirement 17.1).
--   The role test is NOT rewritten here. public.cancellation_can_read_all() from v1.10.0
--   is called, so the manager set stays defined in exactly one place and super_admin
--   keeps every permission manager holds. public.cancellation_is_manager() is not called
--   because no operation below is reserved to Manager_Role: the delete that would have
--   been is simply absent.
--   Like the two v1.10.0 helpers, this function does not test profiles.is_active: no
--   criterion of Requirement 22 conditions cancellation access on the active flag, and
--   adding the test here would be a new access rule this task does not own.
--   It does test auth.uid() is not null before anything else. Without that guard the
--   `assigned_to is null` branch would answer true for a session with no subject, which
--   would hand every unassigned case's evidence to an unauthenticated caller.
--
-- PATH CONVENTION
--   `<case_id>/<random-uuid>.<ext>`, mirroring renewal-contact-evidence's
--   `<record_id>/<random-uuid>.<ext>` (src/features/renewals/api.ts). Only the FIRST
--   segment is authoritative, so `<case_id>/anything/below.png` is still governed by that
--   case and a path whose first segment is not a case id is refused outright. The object
--   name is never trusted as a UUID: a malformed first segment is rejected by regex
--   before any cast, exactly as public.can_access_renewal_evidence() does, so a crafted
--   name raises nothing and simply denies.
--
-- SIZE LIMIT AND MIME TYPES
--   file_size_limit = 104857600 (100 MiB). The design does not state a bucket limit, so
--   this follows the renewal precedent's INTENDED value: v0.9.13 sets
--   renewal-contact-evidence to 104857600 "aligned with the application's 100 MiB limit",
--   and commercial-quote-attachments carries the same number. It is also the only value
--   consistent with the criteria this task cites — Requirements 17.9 and 18.10 reject an
--   evidence file "larger than 100 megabytes", which means a 40 MB file must be ACCEPTED,
--   and MAX_EVIDENCE_SIZE_BYTES in src/features/renewals/api.ts is exactly 100 * 1024 *
--   1024. Note the live renewal bucket currently reads 15728640 because v0.9.8's
--   15 MiB upsert was applied after v0.9.13's; that live value is left exactly as it is
--   (Requirements 26.1, 26.2) and is not copied here.
--   allowed_mime_types = null (unrestricted), mirroring renewal-contact-evidence and
--   commercial-quote-attachments. No criterion restricts evidence to a format: a photo of
--   a receipt, a PDF, a carrier screenshot, and an email export are all evidence. The
--   10-files-per-note cap of Requirement 17.9 is a count, not a storage property, and is
--   enforced by the note submission path.
--
-- WHY THE UPSERT IS `do update` AND NOT `do nothing`
--   The series' idempotent idiom for a bucket is an upsert, and the two security-relevant
--   columns are set on the conflict path rather than skipped: `do nothing` would leave a
--   pre-existing `cancellation-evidence` bucket exactly as it was found, so a bucket that
--   had been created public — by hand, by the dashboard, or by an earlier attempt — would
--   stay public. The post-condition below would then raise and roll this file back,
--   leaving the public bucket in place with no policies on it. Converging the row instead
--   repairs that state, and it is the idiom both v0.9.8 and v0.9.13 use for
--   renewal-contact-evidence. Re-applying this file is therefore safe and self-healing;
--   it never touches any bucket other than the one named.
--
-- ROLLBACK PATH
--   begin;
--     drop policy if exists cancellation_evidence_v1108_select on storage.objects;
--     drop policy if exists cancellation_evidence_v1108_insert on storage.objects;
--     drop function if exists public.cancellation_can_access_evidence(text);
--     delete from storage.buckets where id = 'cancellation-evidence';
--   commit;
--   The bucket delete succeeds only while the bucket holds no object: storage.objects
--   references storage.buckets, so empty the bucket first, and remember that emptying it
--   destroys evidence referenced by cancellation_notes.evidence,
--   cancellation_payment_reports.evidence, and
--   cancellation_verification_outcomes.evidence. Dropping the two policies and the
--   function alone is the safe partial rollback: the bucket then denies every client
--   while its contents survive. No statement in the rollback names any object created at
--   v1.9.7 or earlier, and none names renewal-contact-evidence. Note this is the
--   code-level rollback only; Requirement 26.3 keeps applied v1.10.x migrations in place
--   when application code is rolled back.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 0. BASELINE CAPTURE — Requirements 26.1, 26.2
--
--    Snapshot the pre-existing renewal evidence surface BEFORE this file changes
--    anything, so the post-conditions can prove byte-for-byte that it was left alone
--    rather than merely asserting that it still exists. The temp table is dropped at
--    commit and creates nothing permanent.
-- ═══════════════════════════════════════════════════════════════════════════════
create temporary table v1108_baseline on commit drop as
select
  (select to_jsonb(b) from storage.buckets b where b.id = 'renewal-contact-evidence')
    as renewal_bucket,
  (select coalesce(jsonb_agg(jsonb_build_object(
            'policyname', p.policyname, 'cmd', p.cmd, 'roles', p.roles::text,
            'qual', p.qual, 'with_check', p.with_check) order by p.policyname), '[]'::jsonb)
     from pg_policies p
    where p.schemaname = 'storage' and p.tablename = 'objects'
      and position('renewal-contact-evidence'
                   in lower(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''))) > 0)
    as renewal_policies,
  (select count(*) from storage.buckets where id <> 'cancellation-evidence')
    as other_bucket_count,
  (select coalesce(jsonb_agg(to_jsonb(b) order by b.id), '[]'::jsonb)
     from storage.buckets b where b.id <> 'cancellation-evidence')
    as other_buckets,
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and position('cancellation-evidence'
                   in lower(coalesce(qual, '') || ' ' || coalesce(with_check, ''))) = 0)
    as unrelated_object_policy_count,
  (select count(*) from public.cancellation_cases) as case_count;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE BUCKET — private, 100 MiB, no MIME restriction.
--
--    public = false is the whole point: with it false there is no unauthenticated read
--    path to a customer's evidence at all, and every download has to be a signed URL
--    issued to a caller the select policy below already admitted.
-- ═══════════════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cancellation-evidence', 'cancellation-evidence', false, 104857600, null)
on conflict (id) do update
set public = false,
    file_size_limit = 104857600,
    allowed_mime_types = null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. THE ACCESS TEST
--
--    security definer because it reads public.profiles (through
--    cancellation_can_read_all()) and public.cancellation_cases, neither of which the
--    caller reads in full: the answer must not depend on the caller's own read scope,
--    and once task 7.7 enables row level security on cancellation_cases an invoker-rights
--    version would return a different answer for the same object.
--    stable, so a storage policy can call it once per row without re-planning.
--    set search_path = public, matching v1.10.0, so the function cannot be steered at a
--    different schema's cancellation_cases or profiles.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.cancellation_can_access_evidence(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_actor         uuid := auth.uid();
  v_first_segment text;
  v_case_id       uuid;
begin
  -- No session subject, no access. Checked first so the `assigned_to is null` branch
  -- below can never answer true for an unauthenticated caller.
  if v_actor is null then
    return false;
  end if;

  if p_object_name is null or p_object_name = '' then
    return false;
  end if;

  -- Only the first path segment is authoritative, and it is validated as a UUID by
  -- pattern before any cast, so a malformed or crafted object name denies instead of
  -- raising (same shape as public.can_access_renewal_evidence).
  v_first_segment := split_part(p_object_name, '/', 1);
  if v_first_segment !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_case_id := v_first_segment::uuid;

  -- The design's cancellation_cases read scope, verbatim. The role test is
  -- cancellation_can_read_all() from v1.10.0 — no new role test is defined here.
  return exists (
    select 1
    from public.cancellation_cases c
    where c.id = v_case_id
      and (
        public.cancellation_can_read_all()
        or c.assigned_to = v_actor
        or c.assigned_to is null
      )
  );
end;
$function$;

comment on function public.cancellation_can_access_evidence(text) is
  'True when the signed-in profile may reach the cancellation-evidence object named, decided by reading the first path segment as a Cancellation_Case id and applying the design''s cancellation_cases read scope: cancellation_can_read_all() (manager, super_admin, customer_service, sales_supervisor), or the case is assigned to the caller, or the case is unassigned. Returns false for a null subject, an empty name, a first segment that is not a UUID, and a case that does not exist. Used only by the two cancellation_evidence_v1108_* policies on storage.objects. Requirements 17.9, 18.6, 18.10, 19.9, 22.1, 22.5, 22.12.';

grant execute on function public.cancellation_can_access_evidence(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. THE POLICIES — select and insert only, both to authenticated, both scoped to this
--    one bucket. `drop policy if exists` first so the file is re-appliable; only the two
--    names created here are ever dropped.
-- ═══════════════════════════════════════════════════════════════════════════════
drop policy if exists cancellation_evidence_v1108_select on storage.objects;
create policy cancellation_evidence_v1108_select on storage.objects
for select to authenticated
using (
  bucket_id = 'cancellation-evidence'
  and public.cancellation_can_access_evidence(name)
);

drop policy if exists cancellation_evidence_v1108_insert on storage.objects;
create policy cancellation_evidence_v1108_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'cancellation-evidence'
  and public.cancellation_can_access_evidence(name)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. POST-CONDITIONS
--    Any failure below raises, which rolls the whole migration back rather than leaving a
--    half-secured bucket in place for stage 10 to apply on top of.
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_is_public     boolean;
  v_bucket_name   text;
  v_size_limit    bigint;
  v_mime_types    text[];
  v_secdef        boolean;
  v_volatile      "char";
  v_proconfig     text[];
  v_rls_on        boolean;
  v_count         integer;
  v_baseline      record;
  v_now_bucket    jsonb;
  v_now_policies  jsonb;
  v_now_others    jsonb;
  v_missing       text;
  -- Probe actors and probe cases for the live proofs.
  v_reader_all    uuid;
  v_outsider      uuid;
  v_super_admin   uuid;
  v_case_open     uuid;   -- unassigned
  v_case_theirs   uuid;   -- assigned to v_reader_all
  v_case_mine     uuid;   -- assigned to v_outsider
begin
  select * into v_baseline from v1108_baseline;
  if not found then
    raise exception 'v1.10.8 lost its own baseline snapshot' using hint = 'Rolling back.';
  end if;

  -- ── The bucket exists, and every security-relevant column is what it must be.
  select b.public, b.name, b.file_size_limit, b.allowed_mime_types
    into v_is_public, v_bucket_name, v_size_limit, v_mime_types
    from storage.buckets b where b.id = 'cancellation-evidence';
  if not found then
    raise exception 'v1.10.8 did not create the cancellation-evidence bucket'
      using hint = 'Rolling back.';
  end if;
  if v_is_public then
    raise exception 'v1.10.8 left the cancellation-evidence bucket PUBLIC'
      using detail = 'Customer evidence must be reachable only through a signed URL issued to an authorized caller.',
            hint = 'Rolling back.';
  end if;
  if v_bucket_name <> 'cancellation-evidence' then
    raise exception 'v1.10.8 created the bucket with name % rather than cancellation-evidence',
                    v_bucket_name using hint = 'Rolling back.';
  end if;
  if coalesce(v_size_limit, -1) <> 104857600 then
    raise exception 'v1.10.8 left file_size_limit at % rather than 104857600',
                    coalesce(v_size_limit::text, 'null')
      using detail = 'Requirements 17.9 and 18.10 accept an evidence file up to 100 megabytes.',
            hint = 'Rolling back.';
  end if;
  if v_mime_types is not null then
    raise exception 'v1.10.8 restricted allowed_mime_types to %', v_mime_types::text
      using detail = 'No criterion restricts evidence to a format; renewal-contact-evidence is unrestricted too.',
            hint = 'Rolling back.';
  end if;

  -- ── The access test exists, with the security properties the policies depend on.
  select p.prosecdef, p.provolatile, p.proconfig
    into v_secdef, v_volatile, v_proconfig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'cancellation_can_access_evidence';
  if not found then
    raise exception 'v1.10.8 did not create public.cancellation_can_access_evidence(text)'
      using hint = 'Rolling back.';
  end if;
  if not v_secdef then
    raise exception 'v1.10.8 created cancellation_can_access_evidence as security invoker'
      using detail = 'It reads public.profiles and public.cancellation_cases on behalf of a caller who cannot read them in full.',
            hint = 'Rolling back.';
  end if;
  if v_volatile <> 's' then
    raise exception 'v1.10.8 created cancellation_can_access_evidence with volatility % rather than stable',
                    v_volatile using hint = 'Rolling back.';
  end if;
  if not exists (select 1 from unnest(coalesce(v_proconfig, array[]::text[])) cfg
                  where cfg like 'search_path=%public%') then
    raise exception 'v1.10.8 created cancellation_can_access_evidence without a pinned search_path'
      using detail = 'A security definer function without one can be steered at another schema.',
            hint = 'Rolling back.';
  end if;

  -- ── The v1.10.0 role helper it delegates to is present: no new role test was written.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'cancellation_can_read_all' and p.prosecdef) then
    raise exception 'public.cancellation_can_read_all() is absent: v1.10.0 must be applied before v1.10.8'
      using detail = 'Requirements 22.1, 22.12 define the read-all set in that one helper.',
            hint = 'Rolling back.';
  end if;

  -- ── Exactly the two intended policies target this bucket, each with the right command,
  --    each granted only to authenticated, each routed through the access test.
  select string_agg(c.policyname || ' (' || c.cmd || ')', ', ' order by c.policyname)
    into v_missing
    from (values ('cancellation_evidence_v1108_select', 'SELECT'),
                 ('cancellation_evidence_v1108_insert', 'INSERT')) as c(policyname, cmd)
   where not exists (
     select 1 from pg_policies p
      where p.schemaname = 'storage' and p.tablename = 'objects'
        and p.policyname = c.policyname
        and p.cmd = c.cmd
        and p.roles::text = '{authenticated}'
        and position('cancellation-evidence'
                     in coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) > 0
        and position('cancellation_can_access_evidence'
                     in coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) > 0);
  if v_missing is not null then
    raise exception 'v1.10.8 did not create these storage.objects policies correctly: %', v_missing
      using detail = 'Each must be to authenticated, scoped to bucket cancellation-evidence, and gated by cancellation_can_access_evidence(name).',
            hint = 'Rolling back.';
  end if;

  select count(*) into v_count from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and position('cancellation-evidence'
                  in lower(coalesce(qual, '') || ' ' || coalesce(with_check, ''))) > 0;
  if v_count <> 2 then
    raise exception 'v1.10.8 left % storage.objects policies targeting cancellation-evidence, expected exactly 2',
                    v_count
      using detail = 'No update policy and no delete policy may exist on this bucket (task 7.9).',
            hint = 'Rolling back.';
  end if;

  select count(*) into v_count from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and position('cancellation-evidence'
                  in lower(coalesce(qual, '') || ' ' || coalesce(with_check, ''))) > 0
     and cmd in ('UPDATE', 'DELETE', 'ALL');
  if v_count <> 0 then
    raise exception 'v1.10.8 created % update/delete policy(ies) on cancellation-evidence', v_count
      using detail = 'Evidence is not overwritable or client-deletable; removal is a service-role act.',
            hint = 'Rolling back.';
  end if;

  -- ── Row level security is on for storage.objects, without which the policies above
  --    would decide nothing at all. This file does not set it; Supabase ships it on.
  select c.relrowsecurity into v_rls_on from pg_class c where c.oid = 'storage.objects'::regclass;
  if not coalesce(v_rls_on, false) then
    raise exception 'row level security is disabled on storage.objects: the evidence policies decide nothing'
      using hint = 'Rolling back.';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- LIVE PROOF OF EVERY BRANCH OF THE ACCESS TEST
  --
  -- Three probe cases are inserted, every branch is exercised under a simulated
  -- session, and the probes are deleted again before this block ends. auth.uid() reads
  -- request.jwt.claims, so set_config with is_local = true is enough to simulate a
  -- session: no role is switched and no grant is changed.
  -- ═══════════════════════════════════════════════════════════════════════════
  select id into v_reader_all from public.profiles
   where role::text in ('manager', 'super_admin', 'customer_service', 'sales_supervisor')
   order by id limit 1;
  select id into v_outsider from public.profiles
   where role::text not in ('manager', 'super_admin', 'customer_service', 'sales_supervisor')
   order by id limit 1;
  select id into v_super_admin from public.profiles
   where role::text = 'super_admin' order by id limit 1;

  if v_reader_all is null or v_outsider is null then
    raise exception 'v1.10.8 could not find both a read-all profile and a non-read-all profile to prove the access test with'
      using detail = 'The proofs below need one profile inside cancellation_can_read_all() and one outside it.',
            hint = 'Rolling back.';
  end if;

  insert into public.cancellation_cases
    (policy_number, cancellation_effective_date, raw_row, raw_header, assigned_to)
  values ('V1108-PROBE-OPEN-' || gen_random_uuid()::text, current_date, '[]'::jsonb,
          array['v1108_probe'], null)
  returning id into v_case_open;

  insert into public.cancellation_cases
    (policy_number, cancellation_effective_date, raw_row, raw_header, assigned_to)
  values ('V1108-PROBE-THEIRS-' || gen_random_uuid()::text, current_date, '[]'::jsonb,
          array['v1108_probe'], v_reader_all)
  returning id into v_case_theirs;

  insert into public.cancellation_cases
    (policy_number, cancellation_effective_date, raw_row, raw_header, assigned_to)
  values ('V1108-PROBE-MINE-' || gen_random_uuid()::text, current_date, '[]'::jsonb,
          array['v1108_probe'], v_outsider)
  returning id into v_case_mine;

  -- ── No session: every object is denied, including one on an UNASSIGNED case, which is
  --    the branch that would leak without the auth.uid() guard.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  if public.cancellation_can_access_evidence(v_case_open || '/probe.png')
     or public.cancellation_can_access_evidence(v_case_theirs || '/probe.png')
     or public.cancellation_can_access_evidence(v_case_mine || '/probe.png') then
    raise exception 'v1.10.8 access test allowed an object with no session subject'
      using detail = 'auth.uid() null must deny, including for an unassigned case.',
            hint = 'Rolling back.';
  end if;

  -- ── A read-all profile reads evidence on every case, assigned to it or not.
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_reader_all::text, 'role', 'authenticated')::text, true);
  if not (public.cancellation_can_access_evidence(v_case_open || '/probe.png')
          and public.cancellation_can_access_evidence(v_case_theirs || '/probe.png')
          and public.cancellation_can_access_evidence(v_case_mine || '/probe.png')) then
    raise exception 'v1.10.8 access test denied a read-all profile (%)', v_reader_all
      using detail = 'Requirements 22.1, 22.12: manager, super_admin, customer_service, sales_supervisor read every case.',
            hint = 'Rolling back.';
  end if;

  -- ── Malformed and out-of-scope names are refused even for that read-all profile.
  if public.cancellation_can_access_evidence(null)
     or public.cancellation_can_access_evidence('')
     or public.cancellation_can_access_evidence('probe.png')
     or public.cancellation_can_access_evidence('not-a-uuid/probe.png')
     or public.cancellation_can_access_evidence('../' || v_case_open || '/probe.png')
     or public.cancellation_can_access_evidence('evidence/' || v_case_open || '/probe.png')
     or public.cancellation_can_access_evidence(gen_random_uuid() || '/probe.png') then
    raise exception 'v1.10.8 access test allowed a malformed or unknown-case object name'
      using detail = 'Only a first path segment naming an existing Cancellation_Case may pass.',
            hint = 'Rolling back.';
  end if;

  -- ── A deeper path under a readable case still resolves to that case.
  if not public.cancellation_can_access_evidence(v_case_open || '/2026/probe.png') then
    raise exception 'v1.10.8 access test denied a nested path under a readable case'
      using detail = 'Only the first path segment is authoritative.', hint = 'Rolling back.';
  end if;

  -- ── super_admin holds everything manager holds.
  if v_super_admin is not null then
    perform set_config('request.jwt.claims',
                       json_build_object('sub', v_super_admin::text, 'role', 'authenticated')::text, true);
    if not public.cancellation_can_access_evidence(v_case_theirs || '/probe.png') then
      raise exception 'v1.10.8 access test denied super_admin (%)', v_super_admin
        using detail = 'Requirement 22.5: super_admin inherits every Manager_Role permission.',
              hint = 'Rolling back.';
    end if;
  end if;

  -- ── The ownership branch: a non-read-all profile reaches its own case and an
  --    unassigned case, and is refused a case assigned to somebody else.
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_outsider::text, 'role', 'authenticated')::text, true);
  if not public.cancellation_can_access_evidence(v_case_mine || '/probe.png') then
    raise exception 'v1.10.8 access test denied a profile its own assigned case (%)', v_outsider
      using hint = 'Rolling back.';
  end if;
  if not public.cancellation_can_access_evidence(v_case_open || '/probe.png') then
    raise exception 'v1.10.8 access test denied an unassigned case to a non-read-all profile'
      using detail = 'The design gives Agent_Role assigned_to = auth.uid() OR assigned_to is null.',
            hint = 'Rolling back.';
  end if;
  if public.cancellation_can_access_evidence(v_case_theirs || '/probe.png') then
    raise exception 'v1.10.8 access test allowed a non-read-all profile a case assigned to another profile'
      using detail = 'Evidence visibility must not exceed case visibility.', hint = 'Rolling back.';
  end if;

  -- ── Tear the simulated session down and confirm the deny state returns.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  if public.cancellation_can_access_evidence(v_case_open || '/probe.png') then
    raise exception 'v1.10.8 access test still allowed access after the simulated session ended'
      using hint = 'Rolling back.';
  end if;

  -- ── Remove the probe rows. Only rows this block inserted are deleted.
  delete from public.cancellation_cases
   where id in (v_case_open, v_case_theirs, v_case_mine);

  select count(*) into v_count from public.cancellation_cases;
  if v_count <> v_baseline.case_count then
    raise exception 'v1.10.8 left probe residue in cancellation_cases: % rows, expected %',
                    v_count, v_baseline.case_count
      using hint = 'Rolling back.';
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- REQUIREMENTS 26.1 / 26.2 — the pre-v1.10 storage surface is untouched.
  -- ═══════════════════════════════════════════════════════════════════════════
  select to_jsonb(b) into v_now_bucket from storage.buckets b where b.id = 'renewal-contact-evidence';
  if v_now_bucket is distinct from v_baseline.renewal_bucket then
    raise exception 'v1.10.8 changed the renewal-contact-evidence bucket: % -> %',
                    coalesce(v_baseline.renewal_bucket::text, 'absent'),
                    coalesce(v_now_bucket::text, 'absent')
      using detail = 'Requirements 26.1, 26.2 forbid touching anything created at v1.9.7 or earlier.',
            hint = 'Rolling back.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'policyname', p.policyname, 'cmd', p.cmd, 'roles', p.roles::text,
           'qual', p.qual, 'with_check', p.with_check) order by p.policyname), '[]'::jsonb)
    into v_now_policies
    from pg_policies p
   where p.schemaname = 'storage' and p.tablename = 'objects'
     and position('renewal-contact-evidence'
                  in lower(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''))) > 0;
  if v_now_policies is distinct from v_baseline.renewal_policies then
    raise exception 'v1.10.8 changed the storage.objects policies on renewal-contact-evidence: % -> %',
                    v_baseline.renewal_policies::text, v_now_policies::text
      using detail = 'Requirement 26.2 forbids dropping or altering anything created at v1.9.7 or earlier.',
            hint = 'Rolling back.';
  end if;

  select coalesce(jsonb_agg(to_jsonb(b) order by b.id), '[]'::jsonb) into v_now_others
    from storage.buckets b where b.id <> 'cancellation-evidence';
  if v_now_others is distinct from v_baseline.other_buckets then
    raise exception 'v1.10.8 changed a bucket other than cancellation-evidence: % -> %',
                    v_baseline.other_buckets::text, v_now_others::text
      using hint = 'Rolling back.';
  end if;

  select count(*) into v_count from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and position('cancellation-evidence'
                  in lower(coalesce(qual, '') || ' ' || coalesce(with_check, ''))) = 0;
  if v_count <> v_baseline.unrelated_object_policy_count then
    raise exception 'v1.10.8 changed the count of storage.objects policies unrelated to this bucket: % -> %',
                    v_baseline.unrelated_object_policy_count, v_count
      using hint = 'Rolling back.';
  end if;

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'can_access_renewal_evidence') then
    raise exception 'public.can_access_renewal_evidence() is gone: v1.10.8 must not touch the renewal evidence surface'
      using hint = 'Rolling back.';
  end if;
end
$post$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
select
  (select count(*) from storage.buckets
     where id = 'cancellation-evidence') as bucket_created_expect_1,
  (select public from storage.buckets
     where id = 'cancellation-evidence') as bucket_public_expect_false,
  (select file_size_limit from storage.buckets
     where id = 'cancellation-evidence') as file_size_limit_expect_104857600,
  (select allowed_mime_types from storage.buckets
     where id = 'cancellation-evidence') as allowed_mime_types_expect_null,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'cancellation_can_access_evidence'
       and p.prosecdef
       and p.provolatile = 's') as access_test_secdef_stable_expect_1,
  (select count(*) from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname in ('cancellation_evidence_v1108_select',
                          'cancellation_evidence_v1108_insert')) as new_policies_expect_2,
  (select string_agg(policyname || '=' || cmd || roles::text, ', ' order by policyname)
     from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and position('cancellation-evidence'
                   in lower(coalesce(qual, '') || ' ' || coalesce(with_check, ''))) > 0)
    as cancellation_evidence_policies,
  (select count(*) from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and position('cancellation-evidence'
                    in lower(coalesce(qual, '') || ' ' || coalesce(with_check, ''))) > 0
       and cmd in ('UPDATE', 'DELETE', 'ALL')) as update_or_delete_policies_expect_0,
  (select relrowsecurity from pg_class
     where oid = 'storage.objects'::regclass) as storage_objects_rls_expect_true,
  (select public from storage.buckets
     where id = 'renewal-contact-evidence') as renewal_bucket_still_private_expect_false,
  (select file_size_limit from storage.buckets
     where id = 'renewal-contact-evidence') as renewal_bucket_limit_left_as_found,
  (select count(*) from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and position('renewal-contact-evidence'
                    in lower(coalesce(qual, '') || ' ' || coalesce(with_check, ''))) > 0)
    as renewal_policies_untouched_expect_6,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'can_access_renewal_evidence') as renewal_access_test_intact_expect_1,
  (select count(*) from public.cancellation_cases) as cases_after_probe_cleanup;
