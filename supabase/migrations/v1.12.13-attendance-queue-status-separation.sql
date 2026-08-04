--
-- Spec: .kiro/specs/attendance-queue-status-separation
-- Design: § Fix Implementation items 1, 2, 3, 4, 5, 6, 7, 8, 10, 14
-- Requirements: 2.1–2.14, 2.18, 3.2, 3.7, 3.12, 3.13, 3.15, 3.16
--
-- Forward-only. The latest existing migration is v1.12.12-reporting-filter-performance.sql.
-- No historical migration file is edited (2.13, 3.15).
--
-- WHAT THIS SEPARATES
--   `public.profiles.availability` carries two unrelated facts: whether an employee is at
--   work, and whether an agent is taking sales work. Three Time & Attendance routes wrote it
--   as a side effect of a clock action, discarded the result, and had no opt-in gate. This
--   migration adds the gate, the pre-break memory, the audit table, and one authoritative
--   server-side transition per attendance action.
--
-- WHAT THIS DOES **NOT** TOUCH
--   `set_my_availability` is unchanged and remains the only path that writes
--   `profiles.availability` for a self-service queue change. It owns the profile write, the
--   deterministic `rotation_state` lock order, the `ensure_rotation_valid` recovery, the
--   `advance_rotation` handoff and the `turn_events` rows. Nothing here edits `rotation_state`
--   directly, so this migration adds NO new advancement path (3.7).
--   `advance_rotation`, `ensure_rotation_valid`, `next_eligible_profile`,
--   `is_rotation_eligible`, `pass_my_turn`, `take_quote_turn` and every claim function are
--   untouched. `PATCH /api/time-clock` with `action: 'edit'` still writes no availability (3.11).
--
-- CONTENTS
--   1. public.queue_status_mode enum                        manual | attendance_assisted
--   2. profiles.queue_status_mode                           not null default 'manual'
--   3. time_clock_breaks.pre_break_queue_status             null = "not recorded"
--   4. public.availability_events                           append-only, eight-source vocabulary
--   5. public.record_availability_event(...)                the single insert point
--   6. public.apply_queue_status(...)                       the shared queue-status transition
--   7. public.attendance_status_payload(...)                both statuses, re-read from the database
--   8. public.attendance_clock_in / _clock_out / _break_start / _break_end
--   9. public.set_my_queue_status(...)                      the explicit agent action
--  10. public.manager_set_queue_status_mode(...)            the per-agent opt-in switch
--  11. Grants
--
-- DELIBERATELY NOT IN THIS MIGRATION (deferred, see tasks.md tasks 4.4, 4.5, 4.6)
--   `ensure_daily_availability_reset()` and `admin_deactivate_profile(uuid, uuid, text)` are
--   the other two live writers of `profiles.availability`. They are NOT recreated here, so
--   the `daily_reset` and `user_deactivated` halves of requirement 2.12 are still open. Both
--   source values are already in the check constraint below, so recreating those two
--   functions later needs no constraint change.
--
-- ROLLBACK PATH
--   begin;
--     drop function if exists public.manager_set_queue_status_mode(uuid, public.queue_status_mode, text);
--     drop function if exists public.set_my_queue_status(public.availability_status, text);
--     drop function if exists public.attendance_break_end();
--     drop function if exists public.attendance_break_start(text);
--     drop function if exists public.attendance_clock_out();
--     drop function if exists public.attendance_clock_in(text);
--     drop function if exists public.attendance_status_payload(uuid, boolean, boolean, boolean);
--     drop function if exists public.apply_queue_status(uuid, public.availability_status, text, uuid, uuid, uuid, text, jsonb);
--     drop function if exists public.record_availability_event(uuid, public.availability_status, public.availability_status, text, uuid, uuid, uuid, text, jsonb);
--     drop trigger if exists availability_events_no_update on public.availability_events;
--     drop function if exists public.availability_events_immutable();
--     drop table if exists public.availability_events;
--     alter table public.time_clock_breaks drop column if exists pre_break_queue_status;
--     alter table public.profiles drop column if exists queue_status_mode;
--     drop type if exists public.queue_status_mode;
--   commit;
--   The rollback restores the pre-fix behavior of the four routes only if the routes are
--   rolled back with it: they call these functions and nothing else.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. QUEUE STATUS CONTROL MODE — the per-agent opt-in gate (2.11)
-- ═══════════════════════════════════════════════════════════════════════════════
do $$
begin
  if not exists (
    select 1 from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public' and t.typname = 'queue_status_mode'
  ) then
    create type public.queue_status_mode as enum ('manual', 'attendance_assisted');
  end if;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. profiles.queue_status_mode — additive and defaulted.
--    Every existing profile lands on `manual`, so applying this migration REMOVES
--    attendance-driven queue changes for everyone and turns them back on only where a
--    manager asks for them (2.11). Nothing about `availability` itself changes, so the
--    profile-insert default of `unavailable` is untouched (3.16).
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.profiles
  add column if not exists queue_status_mode public.queue_status_mode not null default 'manual';

comment on column public.profiles.queue_status_mode is
  'manual: only an explicit agent action, an explicit manager action or an authorized '
  'queue-maintenance function may change sales-queue status. attendance_assisted: clock-out, '
  'break-start and break-end may change it too. Requirement 2.11.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. time_clock_breaks.pre_break_queue_status — the memory break-end restores from.
--    Scoped to the break row so it cannot leak across days or across breaks. Null means
--    "not recorded", which is what every historical row and every manual-mode break
--    carries, and is the input to the 2.6 fallback.
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.time_clock_breaks
  add column if not exists pre_break_queue_status public.availability_status;

comment on column public.time_clock_breaks.pre_break_queue_status is
  'The sales-queue status held when this break started, recorded for attendance_assisted '
  'agents only. Null means not recorded; break-end then falls back to unavailable. '
  'Requirements 2.3, 2.4, 2.5, 2.6.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. AVAILABILITY EVENTS — the audit table 2.12 and 2.13 require.
--    No existing table can carry an availability transition: `turn_events` models rotation
--    pointers and its `action` vocabulary is closed, `attendance_audit_log.entity_type` has
--    no availability member, and `audit_log` has no availability writer.
--
--    The `source` vocabulary is closed at EIGHT members. `daily_reset` and
--    `user_deactivated` have no writer yet — they belong to the two functions deferred out
--    of this pass — and they are in the constraint now precisely so that adding those
--    writers later needs no constraint change.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.availability_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id),
  previous_status public.availability_status,          -- null only for a synthetic backfill row
  new_status public.availability_status not null,
  source text not null check (source in (
    'manual_agent',
    'manual_manager',
    'attendance_clock_out',
    'attendance_break_start',
    'attendance_break_end',
    'daily_reset',
    'system_repair',
    'user_deactivated'
  )),
  actor_profile_id uuid not null references public.profiles(id),
  -- No referential action on either: `on delete cascade` and `on delete set null` both fire
  -- the append-only trigger below and would be refused, which turns a clock-entry delete
  -- into a confusing "availability_events is append-only" error. Plain NO ACTION says the
  -- true thing instead — an availability event outlives the attendance row that caused it,
  -- and a referenced clock entry or break cannot be hard-deleted. Nothing in production
  -- deletes either: corrections update them and account deletion is a soft deactivate.
  clock_entry_id uuid references public.time_clock_entries(id),
  break_id uuid references public.time_clock_breaks(id),
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.availability_events is
  'Append-only record of every sales-queue status change: previous status, new status, the '
  'named source, the actor, and the related clock entry or break. Requirement 2.12.';

create index if not exists idx_availability_events_profile
  on public.availability_events(profile_id, created_at desc);

create index if not exists idx_availability_events_created
  on public.availability_events(created_at desc);

create index if not exists idx_availability_events_source
  on public.availability_events(source, created_at desc);

-- Append-only, enforced the same three ways `attendance_audit_log` is: a trigger that
-- refuses even on a security definer path, RLS with no update and no delete policy, and a
-- privilege-level revoke so a client-role attempt fails loudly.
create or replace function public.availability_events_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'availability_events is append-only';
end;
$$;

drop trigger if exists availability_events_no_update on public.availability_events;
create trigger availability_events_no_update
  before update or delete on public.availability_events
  for each row execute function public.availability_events_immutable();

revoke update, delete on public.availability_events from authenticated;
revoke update, delete on public.availability_events from anon;

alter table public.availability_events enable row level security;

-- Select: the employee reads their own rows; manager and super_admin read all (super-admin
-- parity rule). Insert: only through the security definer functions below, which run as the
-- table owner; the policy exists so a direct client insert cannot forge an actor.
drop policy if exists "availability_events_select" on public.availability_events;
create policy "availability_events_select" on public.availability_events
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

drop policy if exists "availability_events_insert" on public.availability_events;
create policy "availability_events_insert" on public.availability_events
  for insert to authenticated
  with check (actor_profile_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. record_availability_event — the single insert point.
--    Every writer goes through it, so the eight-source vocabulary and the one-row-per-change
--    rule live in one place (2.12).
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.record_availability_event(
  p_profile_id uuid,
  p_previous_status public.availability_status,
  p_new_status public.availability_status,
  p_source text,
  p_actor_profile_id uuid,
  p_clock_entry_id uuid default null,
  p_break_id uuid default null,
  p_reason text default null,
  p_metadata jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_profile_id is null then raise exception 'record_availability_event: profile is required'; end if;
  if p_new_status is null then raise exception 'record_availability_event: new status is required'; end if;

  insert into public.availability_events (
    profile_id, previous_status, new_status, source, actor_profile_id,
    clock_entry_id, break_id, reason, metadata
  ) values (
    p_profile_id,
    p_previous_status,
    p_new_status,
    p_source,
    coalesce(p_actor_profile_id, p_profile_id),   -- a system path acts as the profile itself
    p_clock_entry_id,
    p_break_id,
    nullif(btrim(coalesce(p_reason, '')), ''),
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. apply_queue_status — the shared queue-status transition.
--
--    `set_my_availability` derives its subject from `auth.uid()`, so this helper is usable
--    only for the calling employee's own profile. A manager path cannot reuse it.
--
--    The `v_prev = p_new_status` early return is the idempotency point for 2.10: a duplicate
--    request that reaches here finds the value already applied and writes nothing, records
--    nothing and hands off nothing.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.apply_queue_status(
  p_profile_id uuid,
  p_new_status public.availability_status,
  p_source text,
  p_actor uuid,
  p_clock_entry_id uuid default null,
  p_break_id uuid default null,
  p_reason text default null,
  p_metadata jsonb default '{}'::jsonb
) returns public.availability_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev  public.availability_status;
  v_after public.availability_status;
begin
  select availability into v_prev
    from public.profiles
   where id = p_profile_id
     for update;

  if not found then raise exception 'Active profile not found'; end if;

  -- Already there: no write, no event, no handoff.
  if v_prev = p_new_status then return v_prev; end if;

  -- The existing authoritative transition. It owns the profile write, the deterministic
  -- rotation lock order, the ensure_rotation_valid recovery, the advance_rotation handoff
  -- and the turn_events rows. No rotation is edited here (3.6, 3.7).
  perform public.set_my_availability(p_new_status);

  select availability into v_after from public.profiles where id = p_profile_id;

  perform public.record_availability_event(
    p_profile_id      => p_profile_id,
    p_previous_status => v_prev,
    p_new_status      => v_after,
    p_source          => p_source,
    p_actor_profile_id=> coalesce(p_actor, p_profile_id),
    p_clock_entry_id  => p_clock_entry_id,
    p_break_id        => p_break_id,
    p_reason          => p_reason,
    p_metadata        => coalesce(p_metadata, '{}'::jsonb)
  );

  return v_after;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. attendance_status_payload — both statuses, read back from the database (2.18).
--    Nothing in a response is assumed: every attendance function ends by calling this.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.attendance_status_payload(
  p_profile_id uuid,
  p_already_applied boolean default false,
  p_changed_queue boolean default false,
  p_already_open boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry_id      uuid;
  v_clock_in      timestamptz;
  v_clock_out     timestamptz;
  v_clock_status  text;
  v_break_minutes integer;
  v_total_hours   numeric;
  v_open          boolean := false;
  v_break_id      uuid;
  v_break_start   timestamptz;
  v_break_type    text;
  v_pre_break     public.availability_status;
  v_role          public.app_role;
  v_queue         public.availability_status;
  v_mode          public.queue_status_mode;
  v_attendance    text;
  v_is_agent      boolean;
begin
  select id, clock_in, clock_out, clock_status, break_minutes, total_hours
    into v_entry_id, v_clock_in, v_clock_out, v_clock_status, v_break_minutes, v_total_hours
    from public.time_clock_entries
   where profile_id = p_profile_id and clock_out is null
   order by clock_in desc
   limit 1;

  v_open := v_entry_id is not null;

  if not v_open then
    -- The committed state a retry is answered with: the most recent closed entry.
    select id, clock_in, clock_out, clock_status, break_minutes, total_hours
      into v_entry_id, v_clock_in, v_clock_out, v_clock_status, v_break_minutes, v_total_hours
      from public.time_clock_entries
     where profile_id = p_profile_id
     order by clock_in desc
     limit 1;
    v_attendance := 'clocked_out';
  else
    select id, break_start, break_type, pre_break_queue_status
      into v_break_id, v_break_start, v_break_type, v_pre_break
      from public.time_clock_breaks
     where clock_entry_id = v_entry_id and break_end is null
     order by break_start desc
     limit 1;

    v_attendance := case when v_break_id is not null then 'on_break' else 'working' end;
  end if;

  select role, availability, queue_status_mode
    into v_role, v_queue, v_mode
    from public.profiles
   where id = p_profile_id;

  v_is_agent := v_role = 'agent'::public.app_role;

  return jsonb_build_object(
    'attendance_status', v_attendance,
    'queue_status', v_queue,
    'queue_status_mode', v_mode,
    'is_agent', v_is_agent,
    'entry', case
      when v_entry_id is null then null
      else jsonb_build_object(
        'id', v_entry_id,
        'clock_in', v_clock_in,
        'clock_out', v_clock_out,
        'clock_status', v_clock_status,
        'break_minutes', coalesce(v_break_minutes, 0),
        'total_hours', v_total_hours
      )
    end,
    'break', case
      when v_break_id is null then null
      else jsonb_build_object(
        'id', v_break_id,
        'break_start', v_break_start,
        'break_type', v_break_type,
        'pre_break_queue_status', v_pre_break
      )
    end,
    'total_hours', v_total_hours,
    'already_applied', coalesce(p_already_applied, false),
    'already_open', coalesce(p_already_open, false),
    'changed_queue', coalesce(p_changed_queue, false),
    -- 2.1, 2.6, 2.15: the explicit way in is offered whenever an agent is at work and is
    -- not receiving sales work. Never offered to a non-agent, for whom queue status is
    -- meaningless, and never offered to someone who has gone home.
    'offers_join_sales_queues',
      v_is_agent and v_open and coalesce(v_queue, 'unavailable') <> 'available'
  );
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. THE FOUR ATTENDANCE TRANSITION FUNCTIONS
--
--    One transaction each, so a failure in any required step rolls the attendance change
--    back with it — there is no half-applied outcome to warn about (2.7, 2.8).
--
--    Fixed lock order in all four, so no pair can deadlock:
--        time_clock_entries → time_clock_breaks → profiles → rotation_state
--    The last two are `set_my_availability`'s, reached through `apply_queue_status`.
--
--    The queue portion is wrapped so a queue failure is distinguishable from an attendance
--    failure by SQLSTATE `QS001`, which is what the route's `failed_portion` reads. The
--    wrapper re-raises: nothing is swallowed and the whole transaction still rolls back.
--
--    The per-action decision table (design item 7, step 5):
--      role <> 'agent'          → no queue portion at all. Queue status is meaningless for a
--                                 non-agent and `set_my_availability` would refuse. This is
--                                 the deterministic C6 case, fixed by not making the call.
--      mode = manual            → no queue portion (2.9)
--      assisted + clock_in      → no queue change; offer Join Sales Queues (2.1)
--      assisted + clock_out     → unavailable, break open or not (2.2)
--      assisted + break_start   → record pre_break_queue_status; move to break ONLY from
--                                 available, so an ineligible agent never becomes eligible
--                                 through a break (2.3, 2.4)
--      assisted + break_end     → restore pre_break_queue_status exactly; null falls back to
--                                 unavailable and offers Join Sales Queues (2.5, 2.6)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 8a. CLOCK IN ──────────────────────────────────────────────────────────────
create or replace function public.attendance_clock_in(p_status text default 'available')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_role         public.app_role;
  v_entry_id     uuid;
  v_already_open boolean := false;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;

  select role into v_role from public.profiles where id = v_uid and is_active;
  if not found then raise exception 'Active profile not found'; end if;

  if p_status is null or p_status not in ('available', 'lunch', 'unavailable') then
    raise exception 'Invalid status.';
  end if;

  -- The one-open-entry rule stays with `uniq_time_clock_open_entry` rather than a
  -- select-then-insert check, and the loser of the race is still answered with the open row
  -- it lost to (3.13).
  begin
    insert into public.time_clock_entries (profile_id, clock_status)
    values (v_uid, p_status)
    returning id into v_entry_id;
  exception when unique_violation then
    select id into v_entry_id
      from public.time_clock_entries
     where profile_id = v_uid and clock_out is null
     order by clock_in desc
     limit 1;

    -- A readable open entry is what makes this a duplicate rather than a failure.
    if v_entry_id is null then raise; end if;
    v_already_open := true;
  end;

  -- Clock-in never changes queue status, in either mode. The fix here is disclosure: the
  -- payload carries the queue status and offers the explicit way in (2.1, C1).
  return public.attendance_status_payload(
    p_profile_id      => v_uid,
    p_already_applied => false,
    p_changed_queue   => false,
    p_already_open    => v_already_open
  );
end;
$$;

-- ── 8b. CLOCK OUT ─────────────────────────────────────────────────────────────
create or replace function public.attendance_clock_out()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid           uuid := auth.uid();
  v_role          public.app_role;
  v_mode          public.queue_status_mode;
  v_queue         public.availability_status;
  v_entry_id      uuid;
  v_clock_in      timestamptz;
  v_break_minutes integer;
  v_now           timestamptz := now();
  v_total_hours   numeric;
  v_break_id      uuid;
  v_assisted      boolean;
  v_queue_after   public.availability_status;
  v_changed       boolean := false;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;

  select role, queue_status_mode, availability
    into v_role, v_mode, v_queue
    from public.profiles
   where id = v_uid and is_active;
  if not found then raise exception 'Active profile not found'; end if;

  -- Lock the open entry and re-assert that it is still open. In READ COMMITTED the
  -- qualification is re-evaluated after the lock is granted, so the loser of two concurrent
  -- clock-outs finds no row here rather than closing an already-closed entry. A retry lands
  -- in the same branch. Either way the answer is the committed state with
  -- `already_applied: true`, not the HTTP 400 this used to produce (2.10, 1.11).
  select id, clock_in, break_minutes
    into v_entry_id, v_clock_in, v_break_minutes
    from public.time_clock_entries
   where profile_id = v_uid and clock_out is null
   order by clock_in desc
   limit 1
     for update;

  if v_entry_id is null then
    return public.attendance_status_payload(v_uid, true, false, false);
  end if;

  -- End any open break, exactly as the route did: `duration_minutes = 0`.
  update public.time_clock_breaks
     set break_end = v_now, duration_minutes = 0
   where clock_entry_id = v_entry_id and break_end is null
  returning id into v_break_id;

  -- The arithmetic transcribed from the route: clock-out minus clock-in, minus the
  -- accumulated break minutes, rounded to two decimals (3.12).
  v_total_hours := round(
    (((extract(epoch from (v_now - v_clock_in)) / 60.0) - coalesce(v_break_minutes, 0)) / 60.0)::numeric,
    2
  );

  update public.time_clock_entries
     set clock_out = v_now, total_hours = v_total_hours
   where id = v_entry_id;

  v_assisted := v_role = 'agent'::public.app_role
            and v_mode = 'attendance_assisted'::public.queue_status_mode;

  if v_assisted then
    -- Whether or not a break was open. The `if (onBreak)` condition is gone (2.2, C2).
    begin
      v_queue_after := public.apply_queue_status(
        p_profile_id     => v_uid,
        p_new_status     => 'unavailable'::public.availability_status,
        p_source         => 'attendance_clock_out',
        p_actor          => v_uid,
        p_clock_entry_id => v_entry_id,
        p_break_id       => v_break_id,
        p_reason         => 'Clocked out',
        p_metadata       => jsonb_build_object('mode', v_mode, 'had_open_break', v_break_id is not null)
      );
    exception when others then
      raise exception 'queue_status: %', sqlerrm using errcode = 'QS001';
    end;
    v_changed := v_queue_after is distinct from v_queue;
  end if;

  return public.attendance_status_payload(v_uid, false, v_changed, false);
end;
$$;

-- ── 8c. BREAK START ───────────────────────────────────────────────────────────
create or replace function public.attendance_break_start(p_break_type text default 'lunch')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_role         public.app_role;
  v_mode         public.queue_status_mode;
  v_queue        public.availability_status;
  v_entry_id     uuid;
  v_break_id     uuid;
  v_already_open boolean := false;
  v_assisted     boolean;
  v_queue_after  public.availability_status;
  v_changed      boolean := false;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;

  select role, queue_status_mode, availability
    into v_role, v_mode, v_queue
    from public.profiles
   where id = v_uid and is_active;
  if not found then raise exception 'Active profile not found'; end if;

  if p_break_type is null or p_break_type not in ('lunch', 'short', 'personal') then
    raise exception 'Invalid break type.';
  end if;

  select id into v_entry_id
    from public.time_clock_entries
   where profile_id = v_uid and clock_out is null
   order by clock_in desc
   limit 1
     for update;

  if v_entry_id is null then raise exception 'Not clocked in.'; end if;

  v_assisted := v_role = 'agent'::public.app_role
            and v_mode = 'attendance_assisted'::public.queue_status_mode;

  -- The one-open-break rule stays with `uniq_time_clock_open_break`; the loser is answered
  -- with the open break it lost to and owns neither the clock_status update nor the queue
  -- portion (3.13).
  begin
    insert into public.time_clock_breaks (clock_entry_id, break_type, pre_break_queue_status)
    values (v_entry_id, p_break_type, case when v_assisted then v_queue else null end)
    returning id into v_break_id;
  exception when unique_violation then
    select id into v_break_id
      from public.time_clock_breaks
     where clock_entry_id = v_entry_id and break_end is null
     order by break_start desc
     limit 1;

    if v_break_id is null then raise; end if;
    v_already_open := true;
  end;

  if not v_already_open then
    update public.time_clock_entries set clock_status = 'lunch' where id = v_entry_id;

    if v_assisted and v_queue = 'available'::public.availability_status then
      -- Only from Available. Any other value is left alone, so an agent who is not
      -- queue-eligible never becomes eligible through a break (2.3, 2.4).
      begin
        v_queue_after := public.apply_queue_status(
          p_profile_id     => v_uid,
          p_new_status     => 'break'::public.availability_status,
          p_source         => 'attendance_break_start',
          p_actor          => v_uid,
          p_clock_entry_id => v_entry_id,
          p_break_id       => v_break_id,
          p_reason         => 'Break started',
          p_metadata       => jsonb_build_object('mode', v_mode, 'break_type', p_break_type)
        );
      exception when others then
        raise exception 'queue_status: %', sqlerrm using errcode = 'QS001';
      end;
      v_changed := v_queue_after is distinct from v_queue;
    end if;
  end if;

  return public.attendance_status_payload(v_uid, false, v_changed, v_already_open);
end;
$$;

-- ── 8d. BREAK END ─────────────────────────────────────────────────────────────
create or replace function public.attendance_break_end()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid           uuid := auth.uid();
  v_role          public.app_role;
  v_mode          public.queue_status_mode;
  v_queue         public.availability_status;
  v_entry_id      uuid;
  v_break_minutes integer;
  v_break_id      uuid;
  v_break_start   timestamptz;
  v_break_type    text;
  v_pre_break     public.availability_status;
  v_now           timestamptz := now();
  v_duration      integer;
  v_assisted      boolean;
  v_target        public.availability_status;
  v_queue_after   public.availability_status;
  v_changed       boolean := false;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;

  select role, queue_status_mode, availability
    into v_role, v_mode, v_queue
    from public.profiles
   where id = v_uid and is_active;
  if not found then raise exception 'Active profile not found'; end if;

  select id, break_minutes
    into v_entry_id, v_break_minutes
    from public.time_clock_entries
   where profile_id = v_uid and clock_out is null
   order by clock_in desc
   limit 1
     for update;

  -- No open entry: the clock-out already closed this break. Answer with the committed
  -- state rather than an error (2.10, 1.11).
  if v_entry_id is null then
    return public.attendance_status_payload(v_uid, true, false, false);
  end if;

  -- Same post-lock re-assert as clock-out: the loser of two concurrent break-ends, and a
  -- retry, both find no open break here.
  select id, break_start, break_type, pre_break_queue_status
    into v_break_id, v_break_start, v_break_type, v_pre_break
    from public.time_clock_breaks
   where clock_entry_id = v_entry_id and break_end is null
   order by break_start desc
   limit 1
     for update;

  if v_break_id is null then
    return public.attendance_status_payload(v_uid, true, false, false);
  end if;

  v_duration := round(extract(epoch from (v_now - v_break_start)) / 60.0)::integer;

  update public.time_clock_breaks
     set break_end = v_now, duration_minutes = v_duration
   where id = v_break_id;

  -- Only lunch is deducted from paid time; short and personal breaks are paid (3.12).
  if v_break_type = 'lunch' then
    update public.time_clock_entries
       set break_minutes = coalesce(v_break_minutes, 0) + v_duration,
           clock_status = 'available'
     where id = v_entry_id;
  else
    update public.time_clock_entries
       set clock_status = 'available'
     where id = v_entry_id;
  end if;

  v_assisted := v_role = 'agent'::public.app_role
            and v_mode = 'attendance_assisted'::public.queue_status_mode;

  if v_assisted then
    -- Non-null restores exactly that value, so Available restores Available and
    -- Unavailable restores Unavailable (2.5). Null falls back to Unavailable and the
    -- payload offers Join Sales Queues (2.6).
    v_target := coalesce(v_pre_break, 'unavailable'::public.availability_status);

    begin
      v_queue_after := public.apply_queue_status(
        p_profile_id     => v_uid,
        p_new_status     => v_target,
        p_source         => 'attendance_break_end',
        p_actor          => v_uid,
        p_clock_entry_id => v_entry_id,
        p_break_id       => v_break_id,
        p_reason         => case
                              when v_pre_break is null then 'Break ended, no pre-break status recorded'
                              else 'Break ended, pre-break status restored'
                            end,
        p_metadata       => jsonb_build_object(
                              'mode', v_mode,
                              'break_type', v_break_type,
                              'pre_break_queue_status', v_pre_break
                            )
      );
    exception when others then
      raise exception 'queue_status: %', sqlerrm using errcode = 'QS001';
    end;

    v_changed := v_queue_after is distinct from v_queue;
  end if;

  return public.attendance_status_payload(v_uid, false, v_changed, false)
         || jsonb_build_object('duration_minutes', v_duration);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. set_my_queue_status — the explicit agent action behind the My status control.
--    Same immediate change, same surfaced error, same live refresh as
--    `set_my_availability` (3.10); the addition is the `manual_agent` audit event (2.9, 2.12).
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.set_my_queue_status(
  p_status public.availability_status,
  p_reason text default null
) returns public.availability_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_status is null then raise exception 'A queue status is required'; end if;

  return public.apply_queue_status(
    p_profile_id     => v_uid,
    p_new_status     => p_status,
    p_source         => 'manual_agent',
    p_actor          => v_uid,
    p_clock_entry_id => null,
    p_break_id       => null,
    p_reason         => p_reason,
    p_metadata       => jsonb_build_object('via', 'set_my_queue_status')
  );
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. manager_set_queue_status_mode — the per-agent opt-in switch (2.11).
--     Guarded by `is_manager()`, which is `manager` and `super_admin` exactly, because 2.11
--     restricts the mode change to those two roles and `can_manage_sales()` would
--     additionally admit `sales_supervisor`. Reason required. Changes no availability and
--     writes no `availability_events` row.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.manager_set_queue_status_mode(
  p_profile_id uuid,
  p_mode public.queue_status_mode,
  p_reason text
) returns public.queue_status_mode
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_old   public.queue_status_mode;
begin
  if not public.is_manager() then raise exception 'Manager permission required'; end if;
  if p_profile_id is null then raise exception 'A profile is required'; end if;
  if p_mode is null then raise exception 'A queue status mode is required'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required';
  end if;

  select queue_status_mode into v_old
    from public.profiles
   where id = p_profile_id and is_active
     for update;
  if not found then raise exception 'Active profile not found'; end if;

  if v_old = p_mode then return v_old; end if;

  update public.profiles set queue_status_mode = p_mode where id = p_profile_id;

  insert into public.audit_log (
    actor_profile_id, action, entity_type, entity_id, old_value, new_value, reason
  ) values (
    v_actor,
    'queue_status_mode_changed',
    'profile',
    p_profile_id,
    jsonb_build_object('queue_status_mode', v_old),
    jsonb_build_object('queue_status_mode', p_mode),
    btrim(p_reason)
  );

  return p_mode;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. GRANTS (design item 14)
--     `record_availability_event` and `apply_queue_status` are internal: service_role only.
--     The security definer functions above call them as the function owner, so the four
--     attendance functions keep working for an `authenticated` caller without that grant.
-- ═══════════════════════════════════════════════════════════════════════════════
revoke all on function public.record_availability_event(
  uuid, public.availability_status, public.availability_status, text, uuid, uuid, uuid, text, jsonb
) from public;
revoke all on function public.apply_queue_status(
  uuid, public.availability_status, text, uuid, uuid, uuid, text, jsonb
) from public;

grant execute on function public.record_availability_event(
  uuid, public.availability_status, public.availability_status, text, uuid, uuid, uuid, text, jsonb
) to service_role;
grant execute on function public.apply_queue_status(
  uuid, public.availability_status, text, uuid, uuid, uuid, text, jsonb
) to service_role;

grant execute on function public.attendance_status_payload(uuid, boolean, boolean, boolean)
  to authenticated, service_role;
grant execute on function public.attendance_clock_in(text) to authenticated, service_role;
grant execute on function public.attendance_clock_out() to authenticated, service_role;
grant execute on function public.attendance_break_start(text) to authenticated, service_role;
grant execute on function public.attendance_break_end() to authenticated, service_role;
grant execute on function public.set_my_queue_status(public.availability_status, text)
  to authenticated, service_role;

-- Enforces its own role check, so the grant is to every signed-in caller.
grant execute on function public.manager_set_queue_status_mode(uuid, public.queue_status_mode, text)
  to authenticated, service_role;

commit;

-- PostgREST caches the schema, so a new function or column is invisible to the REST API
-- until it reloads.
notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
select
  (select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'queue_status_mode') as mode_enum,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'queue_status_mode') as profiles_column,
  (select count(*) from public.profiles where queue_status_mode <> 'manual') as non_manual_profiles_must_be_zero,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'time_clock_breaks'
      and column_name = 'pre_break_queue_status') as break_column,
  (select count(*) from pg_tables
    where schemaname = 'public' and tablename = 'availability_events') as events_table,
  (select count(*) from pg_indexes
    where schemaname = 'public'
      and indexname in ('idx_availability_events_profile',
                        'idx_availability_events_created',
                        'idx_availability_events_source')) as events_indexes,
  (select count(*) from pg_trigger
    where tgname = 'availability_events_no_update' and not tgisinternal) as events_trigger,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'availability_events') as events_policies,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'availability_events'
      and cmd in ('UPDATE', 'DELETE')) as events_write_policies_must_be_zero,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('record_availability_event', 'apply_queue_status',
                        'attendance_status_payload', 'attendance_clock_in',
                        'attendance_clock_out', 'attendance_break_start',
                        'attendance_break_end', 'set_my_queue_status',
                        'manager_set_queue_status_mode')) as functions_created;
