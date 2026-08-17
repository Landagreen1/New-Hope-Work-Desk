-- New Hope Work Desk v1.15.3 — Intake production, attributed correctly.
--
-- Shared drafts split one fact into two. Before v1.15.0 the employee who started
-- an intake was necessarily the employee who finished it, so `created_by` answered
-- both "who started this?" and "who produced this completed intake?". It no longer
-- does: Vivian can start a draft, and Maria can finish and submit it.
--
-- The rule this migration implements:
--
--   Drafts Started    counted on created_by     — who opened the record
--   Intakes Completed counted on completed_by   — who finished and submitted it
--
-- and an unfinished draft is never counted as a completed intake.
--
-- ── Historical compatibility ─────────────────────────────────────────────────
--
-- Rows submitted before v1.15.0 have no completed_by, because there was nothing
-- to record. Completion credit therefore reads
--
--   coalesce(completed_by, created_by)
--
-- which reproduces exactly how those rows have always been counted. No historical
-- production total moves. completed_by is deliberately not backfilled: inventing it
-- would be a guess, and a guess that rewrites people's numbers.
--
-- ── What this does NOT change ────────────────────────────────────────────────
--
-- Checked before writing: no existing report attributes intake creation to an
-- employee. reporting_quote_facts joins cs_intake_submissions but reads only
-- is_walk_in, intake_channel and source_type from it, and no other view or
-- function in the database counts intakes by person. So there was no report to
-- correct — this adds the attribution rather than fixing a wrong one, which is why
-- no existing sales metric shifts as a result of this migration.
--
-- Quote credit for the resulting *quote* is untouched: that belongs to the sales
-- agent through work_items.assigned_profile_id and
-- daily_agent_performance.ringcentral_quotes, and none of it is read here.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- cs_intake_production
-- ═══════════════════════════════════════════════════════════════════════════════
-- Both metrics side by side for a date range, because they answer different
-- questions and reporting one without the other is how a shared draft starts
-- looking like lost work.
--
-- p_profile_id null means "everyone", which requires management access. Anyone may
-- ask for their own numbers.

create or replace function public.cs_intake_production(
  p_from date,
  p_to date,
  p_profile_id uuid default null
)
returns table (
  profile_id uuid,
  display_name text,
  drafts_started bigint,
  intakes_completed bigint,
  completed_for_others bigint,
  started_completed_by_others bigint,
  drafts_open bigint
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_is_manager boolean := public.can_manage_sales() or public.can_manage_customer_service();
begin
  if auth.uid() is null then
    raise exception 'Sign in to read intake production.';
  end if;

  -- Asking about somebody else, or about everybody, is a management question.
  if not v_is_manager and (p_profile_id is null or p_profile_id <> auth.uid()) then
    raise exception 'You can only read your own intake production.';
  end if;

  if p_from is null or p_to is null then
    raise exception 'A from date and a to date are required.';
  end if;

  return query
  with scope as (
    select p.id, p.display_name
    from public.profiles p
    where (p_profile_id is null or p.id = p_profile_id)
  ),
  started as (
    -- Who opened the record. created_by is never rewritten, so this stays true
    -- even when somebody else finishes the draft.
    select s.created_by as profile_id, count(*)::bigint as total
    from public.cs_intake_submissions s
    where s.created_at::date between p_from and p_to
    group by s.created_by
  ),
  completed as (
    -- Who finished and submitted it. The coalesce is the historical fallback.
    select coalesce(s.completed_by, s.created_by) as profile_id, count(*)::bigint as total
    from public.cs_intake_submissions s
    where s.submitted_at is not null
      and s.submitted_at::date between p_from and p_to
    group by coalesce(s.completed_by, s.created_by)
  ),
  completed_others as (
    -- Finished somebody else's draft. Visible so that picking up a teammate's
    -- unfinished work reads as a contribution rather than disappearing.
    select s.completed_by as profile_id, count(*)::bigint as total
    from public.cs_intake_submissions s
    where s.submitted_at is not null
      and s.submitted_at::date between p_from and p_to
      and s.completed_by is not null
      and s.completed_by <> s.created_by
    group by s.completed_by
  ),
  handed_off as (
    -- Started it, somebody else finished it. The starter's contribution stays
    -- visible even though the completion credit went elsewhere.
    select s.created_by as profile_id, count(*)::bigint as total
    from public.cs_intake_submissions s
    where s.submitted_at is not null
      and s.submitted_at::date between p_from and p_to
      and s.completed_by is not null
      and s.completed_by <> s.created_by
    group by s.created_by
  ),
  open_drafts as (
    -- Point-in-time, not range-bound: an unfinished draft is unfinished now.
    select s.created_by as profile_id, count(*)::bigint as total
    from public.cs_intake_submissions s
    where s.status::text in ('draft', 'returned')
    group by s.created_by
  )
  select
    scope.id,
    scope.display_name,
    coalesce(started.total, 0),
    coalesce(completed.total, 0),
    coalesce(completed_others.total, 0),
    coalesce(handed_off.total, 0),
    coalesce(open_drafts.total, 0)
  from scope
  left join started on started.profile_id = scope.id
  left join completed on completed.profile_id = scope.id
  left join completed_others on completed_others.profile_id = scope.id
  left join handed_off on handed_off.profile_id = scope.id
  left join open_drafts on open_drafts.profile_id = scope.id
  where coalesce(started.total, 0)
      + coalesce(completed.total, 0)
      + coalesce(open_drafts.total, 0) > 0
  order by coalesce(completed.total, 0) desc, scope.display_name;
end;
$fn$;

revoke execute on function public.cs_intake_production(date, date, uuid) from public, anon;
grant execute on function public.cs_intake_production(date, date, uuid) to authenticated;

comment on function public.cs_intake_production(date, date, uuid) is
  'Intake production for a date range. Drafts Started counts created_by; Intakes Completed counts coalesce(completed_by, created_by) so rows submitted before v1.15.0 keep reporting exactly as they always have. An unfinished draft is never counted as a completed intake.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- cs_intake_my_work
-- ═══════════════════════════════════════════════════════════════════════════════
-- The intakes an employee has a hand in.
--
-- Replaces a plain `created_by = me` filter, which stopped telling the truth the
-- moment drafts became shared: an intake Maria finished for Vivian appeared on
-- neither of their lists in a way that reflected what each had done. This returns
-- anything the employee started, last edited, or completed, and says which.

create or replace function public.cs_intake_my_work(
  p_limit integer default 200
)
returns table (
  submission_id uuid,
  involvement text[]
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_me uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  if v_me is null then
    raise exception 'Sign in to read your intake work.';
  end if;

  return query
  select
    s.id,
    array_remove(array[
      case when s.created_by = v_me then 'started' end,
      case when s.completed_by = v_me then 'completed' end,
      case when s.last_edited_by = v_me and s.created_by <> v_me then 'edited' end
    ], null)::text[]
  from public.cs_intake_submissions s
  where s.created_by = v_me
     or s.completed_by = v_me
     or s.last_edited_by = v_me
  order by s.updated_at desc
  limit v_limit;
end;
$fn$;

revoke execute on function public.cs_intake_my_work(integer) from public, anon;
grant execute on function public.cs_intake_my_work(integer) to authenticated;

comment on function public.cs_intake_my_work(integer) is
  'The intakes the calling employee started, last edited, or completed, tagged with which. A shared draft finished by a teammate stays visible to both, described accurately for each.';

commit;
