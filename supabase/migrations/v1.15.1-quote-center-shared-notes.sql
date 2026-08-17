-- New Hope Work Desk v1.15.1 — Documentation is never blocked by ownership.
--
-- A customer calls Customer Service about a quote a Sales agent owns. The person
-- who answers has to be able to write down what was said. Ownership decides who
-- is responsible for working the quote; it must not decide who may record a
-- conversation.
--
-- Two paths, because a journey has two halves and each already has an
-- append-only log. No third notes system is introduced:
--
--   before conversion → cs_intake_events, event_type 'note_added'
--   after conversion  → quote_notes, through the existing add_quote_note
--
-- The Quote Center timeline merges both, so the employee sees one history.
--
-- Verified against live Supabase first: add_quote_note already has no ownership
-- test, so only its role list is short. quote_notes has a SELECT-only policy
-- (`using (true)`) and no INSERT policy, which is why writes go through a
-- security-definer function and why notes cannot be edited or deleted from the
-- client at all.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. add_quote_note — role parity
-- ═══════════════════════════════════════════════════════════════════════════════
-- The live role list was ('agent','manager','customer_service'), which silently
-- excluded super admins and all three scoped supervisors. Body is otherwise the
-- live body: still no ownership test, still verifying the quote exists in one of
-- the three lifecycle tables, still writing an audit_log row.

create or replace function public.add_quote_note(
  p_source_work_item_id uuid,
  p_note text
)
returns public.quote_notes
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_profile public.profiles%rowtype;
  v_note public.quote_notes%rowtype;
  v_text text := nullif(btrim(p_note), '');
  v_quote_exists boolean;
begin
  select * into v_profile
  from public.profiles
  where id = auth.uid()
    and is_active
    and role::text in (
      'agent',
      'manager',
      'customer_service',
      -- v1.15.1: super admins inherit every manager capability, and the scoped
      -- supervisors documented a quote they could already read.
      'super_admin',
      'sales_supervisor',
      'customer_service_supervisor'
    );

  if not found then
    raise exception 'Active Work Desk user permission required';
  end if;

  if p_source_work_item_id is null then
    raise exception 'Quote id is required';
  end if;

  if v_text is null then
    raise exception 'A follow-up note is required';
  end if;

  -- Ownership is deliberately not consulted. The note records who wrote it and
  -- when; it does not reassign the quote.
  select exists (
    select 1 from public.work_items w
      where w.id = p_source_work_item_id
        and w.work_type in ('new_quote', 'requote')
    union all
    select 1 from public.pending_pricing_quotes p
      where p.source_work_item_id = p_source_work_item_id
    union all
    select 1 from public.quote_outcomes q
      where q.source_work_item_id = p_source_work_item_id
  ) into v_quote_exists;

  if not v_quote_exists then
    raise exception 'Quote not found';
  end if;

  insert into public.quote_notes(source_work_item_id, author_profile_id, note)
  values (p_source_work_item_id, auth.uid(), v_text)
  returning * into v_note;

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, new_value)
  values (auth.uid(), 'quote_note_added', 'quote', p_source_work_item_id, to_jsonb(v_note));

  return v_note;
end;
$fn$;

revoke execute on function public.add_quote_note(uuid, text) from public, anon;
grant execute on function public.add_quote_note(uuid, text) to authenticated;

comment on function public.add_quote_note(uuid, text) is
  'Appends an operational note to a quote at any lifecycle stage. Deliberately has no ownership test: Customer Service must be able to document a call about a quote a Sales agent owns. Writing a note never changes assignment.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. cs_intake_add_note — notes on an intake that has not become a quote yet
-- ═══════════════════════════════════════════════════════════════════════════════
-- Reuses cs_intake_events, which is already append-only by omission: it has a
-- SELECT and an INSERT policy and no UPDATE or DELETE policy, so a note written
-- here cannot be rewritten later. Corrections are additional notes, which is
-- what an operational history should do.

create or replace function public.cs_intake_add_note(
  p_submission_id uuid,
  p_note text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_text text := nullif(btrim(p_note), '');
  v_event_id uuid;
  v_role text;
  v_exists boolean;
begin
  if auth.uid() is null then
    raise exception 'Sign in to add a note.';
  end if;

  if v_text is null then
    raise exception 'A note is required.';
  end if;

  if char_length(v_text) > 2000 then
    raise exception 'A note may be at most 2000 characters.';
  end if;

  select role::text into v_role
  from public.profiles
  where id = auth.uid() and is_active;

  if v_role is null then
    raise exception 'Active Work Desk user permission required.';
  end if;

  if v_role not in (
    'agent',
    'manager',
    'customer_service',
    'super_admin',
    'sales_supervisor',
    'customer_service_supervisor'
  ) then
    raise exception 'Your role cannot add notes to quote intakes.';
  end if;

  -- Reading the intake is the prerequisite, not owning it.
  if not public.can_read_cs_intake(p_submission_id) then
    raise exception 'This intake is not available to you.';
  end if;

  select exists (
    select 1 from public.cs_intake_submissions where id = p_submission_id
  ) into v_exists;

  if not v_exists then
    raise exception 'Intake not found.';
  end if;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (
    p_submission_id,
    auth.uid(),
    'note_added',
    jsonb_build_object('note', v_text, 'author_role', v_role)
  )
  returning id into v_event_id;

  insert into public.audit_log(actor_profile_id, action, entity_type, entity_id, new_value)
  values (
    auth.uid(),
    'cs_intake_note_added',
    'cs_intake_submission',
    p_submission_id,
    jsonb_build_object('event_id', v_event_id)
  );

  return v_event_id;
end;
$fn$;

revoke execute on function public.cs_intake_add_note(uuid, text) from public, anon;
grant execute on function public.cs_intake_add_note(uuid, text) to authenticated;

comment on function public.cs_intake_add_note(uuid, text) is
  'Appends a note to an intake that has not yet become a quote. Requires read access, not ownership. Writes to cs_intake_events, which has no UPDATE or DELETE policy, so intake notes are append-only.';

commit;
