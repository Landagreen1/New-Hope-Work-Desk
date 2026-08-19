-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.19.0 — Agent Queue State V2
--
-- Redesigns queue-status ownership so that:
--   1. agent_queue_state is the ONE authoritative source of truth.
--   2. Every transition goes through transition_agent_queue_status().
--   3. Optimistic concurrency via version prevents stale writes.
--   4. Attendance break-end cannot overwrite a newer manual decision.
--   5. Dashboard loads never mutate queue state.
--   6. Every change is auditable with source, actor, and version.
--   7. profiles.availability becomes a synchronized legacy mirror only.
--
-- This migration creates the new state machine. Subsequent sections rewire
-- all existing callers to use it.
-- ═══════════════════════════════════════════════════════════════════════════════
begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. AGENT_QUEUE_STATE — the single authoritative queue-status record per agent.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.agent_queue_state (
  profile_id  uuid primary key references public.profiles(id) on delete cascade,
  status      public.availability_status not null default 'unavailable',
  version     bigint not null default 1,
  changed_at  timestamptz not null default now(),
  changed_by  uuid references public.profiles(id),
  source      text not null default 'system_migration',
  reason      text,
  cause_id    uuid,
  metadata    jsonb not null default '{}'::jsonb
);

comment on table public.agent_queue_state is
  'Single source of truth for agent sales-queue participation status. '
  'All writes go through transition_agent_queue_status(). '
  'profiles.availability is maintained as a read-only legacy mirror.';

comment on column public.agent_queue_state.version is
  'Monotonically increasing version number. Used for optimistic concurrency: '
  'a caller may pass p_expected_version to reject stale writes.';

comment on column public.agent_queue_state.source is
  'The system or actor that caused this transition. Closed vocabulary: '
  'agent_manual, manager_manual, attendance_break_start, attendance_break_end, '
  'attendance_clock_out, daily_reset, system_migration, system_recovery, user_deactivated.';

-- Index for dashboard reads that filter by status
create index if not exists idx_agent_queue_state_status
  on public.agent_queue_state(status);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. AGENT_QUEUE_STATUS_EVENTS — immutable audit trail of every transition.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.agent_queue_status_events (
  id               uuid primary key default gen_random_uuid(),
  profile_id       uuid not null references public.profiles(id),
  previous_status  public.availability_status,
  new_status       public.availability_status not null,
  previous_version bigint,
  new_version      bigint not null,
  source           text not null,
  reason           text,
  changed_by       uuid references public.profiles(id),
  cause_id         uuid,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

comment on table public.agent_queue_status_events is
  'Append-only audit log of every queue-status transition. Every call to '
  'transition_agent_queue_status() produces exactly one row here. '
  'Answers: WHAT changed, WHO changed it, WHEN, WHY, FROM what, TO what, WHICH version.';

create index if not exists idx_aqse_profile_created
  on public.agent_queue_status_events(profile_id, created_at desc);

create index if not exists idx_aqse_created
  on public.agent_queue_status_events(created_at desc);

create index if not exists idx_aqse_source
  on public.agent_queue_status_events(source, created_at desc);

-- Append-only enforcement: trigger + privilege revocation
create or replace function public.agent_queue_status_events_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'agent_queue_status_events is append-only';
end;
$$;

drop trigger if exists aqse_no_update on public.agent_queue_status_events;
create trigger aqse_no_update
  before update or delete on public.agent_queue_status_events
  for each row execute function public.agent_queue_status_events_immutable();

revoke update, delete on public.agent_queue_status_events from authenticated;
revoke update, delete on public.agent_queue_status_events from anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. RLS for agent_queue_state
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.agent_queue_state enable row level security;

-- Everyone can read queue state (needed for rotation eligibility checks in the UI)
drop policy if exists "aqst_select" on public.agent_queue_state;
create policy "aqst_select" on public.agent_queue_state
  for select to authenticated
  using (true);

-- No direct inserts/updates/deletes from clients — all writes go through SECURITY DEFINER RPCs
drop policy if exists "aqst_no_direct_write" on public.agent_queue_state;
create policy "aqst_no_direct_write" on public.agent_queue_state
  for insert to authenticated
  with check (false);

drop policy if exists "aqst_no_direct_update" on public.agent_queue_state;
create policy "aqst_no_direct_update" on public.agent_queue_state
  for update to authenticated
  using (false);

drop policy if exists "aqst_no_direct_delete" on public.agent_queue_state;
create policy "aqst_no_direct_delete" on public.agent_queue_state
  for delete to authenticated
  using (false);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. RLS for agent_queue_status_events
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.agent_queue_status_events enable row level security;

-- Agents see their own events; managers/super_admin see all
drop policy if exists "aqse_select" on public.agent_queue_status_events;
create policy "aqse_select" on public.agent_queue_status_events
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
  );

-- No direct insert from client — only through SECURITY DEFINER
drop policy if exists "aqse_no_direct_insert" on public.agent_queue_status_events;
create policy "aqse_no_direct_insert" on public.agent_queue_status_events
  for insert to authenticated
  with check (false);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. TRANSITION_AGENT_QUEUE_STATUS — the ONE gateway for all queue-state changes.
--
--    This function:
--    a) Locks the agent_queue_state row (SELECT FOR UPDATE).
--    b) Reads current status + version.
--    c) Optionally verifies p_expected_version for optimistic concurrency.
--    d) Rejects stale writes with a structured JSONB error.
--    e) Applies the transition.
--    f) Increments version.
--    g) Records source/actor/reason.
--    h) Inserts an immutable audit event.
--    i) Syncs the legacy profiles.availability mirror.
--    j) Performs rotation handoffs (via set_my_availability mechanics).
--    k) Returns the full updated state as JSONB for the frontend.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.transition_agent_queue_status(
  p_profile_id       uuid,
  p_new_status       public.availability_status,
  p_source           text,
  p_reason           text default null,
  p_expected_version bigint default null,
  p_cause_id         uuid default null,
  p_changed_by       uuid default null,
  p_metadata         jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_status  public.availability_status;
  v_current_version bigint;
  v_new_version     bigint;
  v_actor           uuid;
  v_profile_exists  boolean;
  v_is_agent        boolean;
begin
  -- Validate inputs
  if p_profile_id is null then
    raise exception 'transition_agent_queue_status: profile_id is required';
  end if;
  if p_new_status is null then
    raise exception 'transition_agent_queue_status: new_status is required';
  end if;
  if p_source is null or p_source not in (
    'agent_manual',
    'manager_manual',
    'attendance_break_start',
    'attendance_break_end',
    'attendance_clock_out',
    'daily_reset',
    'system_migration',
    'system_recovery',
    'user_deactivated'
  ) then
    raise exception 'transition_agent_queue_status: invalid source "%"', coalesce(p_source, 'NULL');
  end if;

  v_actor := coalesce(p_changed_by, auth.uid(), p_profile_id);

  -- ─── DAILY RESET CHECK ───────────────────────────────────────────────────
  -- The daily reset is triggered by the first queue-status transition of a new
  -- business day (excluding the reset itself, to prevent recursion). This
  -- replaces the old pattern of calling it during dashboard loads.
  if p_source <> 'daily_reset' then
    perform public.ensure_daily_availability_reset();
  end if;

  -- Verify profile exists and is active
  select exists(
    select 1 from public.profiles where id = p_profile_id and is_active
  ) into v_profile_exists;

  if not v_profile_exists then
    raise exception 'transition_agent_queue_status: active profile not found';
  end if;

  -- Lock and read current state (upsert if row doesn't exist yet — migration safety)
  insert into public.agent_queue_state (profile_id, status, version, changed_at, changed_by, source)
  values (p_profile_id, 'unavailable', 0, now(), v_actor, 'system_migration')
  on conflict (profile_id) do nothing;

  select status, version
    into v_current_status, v_current_version
    from public.agent_queue_state
   where profile_id = p_profile_id
     for update;

  -- Optimistic concurrency check
  if p_expected_version is not null and v_current_version <> p_expected_version then
    return jsonb_build_object(
      'success', false,
      'reason', 'STALE_QUEUE_STATE',
      'current_status', v_current_status,
      'current_version', v_current_version,
      'expected_version', p_expected_version,
      'profile_id', p_profile_id
    );
  end if;

  -- Idempotency: already in the requested state
  if v_current_status = p_new_status then
    return jsonb_build_object(
      'success', true,
      'changed', false,
      'profile_id', p_profile_id,
      'status', v_current_status,
      'version', v_current_version,
      'source', p_source
    );
  end if;

  -- Compute new version
  v_new_version := v_current_version + 1;

  -- Apply the transition
  update public.agent_queue_state
     set status     = p_new_status,
         version    = v_new_version,
         changed_at = now(),
         changed_by = v_actor,
         source     = p_source,
         reason     = nullif(btrim(coalesce(p_reason, '')), ''),
         cause_id   = p_cause_id,
         metadata   = coalesce(p_metadata, '{}'::jsonb)
   where profile_id = p_profile_id;

  -- Record immutable audit event
  insert into public.agent_queue_status_events (
    profile_id, previous_status, new_status, previous_version, new_version,
    source, reason, changed_by, cause_id, metadata
  ) values (
    p_profile_id, v_current_status, p_new_status, v_current_version, v_new_version,
    p_source, nullif(btrim(coalesce(p_reason, '')), ''), v_actor, p_cause_id,
    coalesce(p_metadata, '{}'::jsonb)
  );

  -- ─── LEGACY MIRROR: keep profiles.availability in sync ───────────────────
  -- This is a WRITE-THROUGH from the authoritative agent_queue_state.
  -- profiles.availability must NOT be written by any other path.
  update public.profiles
     set availability = p_new_status
   where id = p_profile_id
     and availability is distinct from p_new_status;

  -- ─── ROTATION HANDOFF ────────────────────────────────────────────────────
  -- When status leaves 'available', hand off any held rotation turns.
  -- When status becomes 'available', recover empty rotations.
  -- This replicates the logic from set_my_availability but operates on the
  -- new authoritative state.
  select role = 'agent' into v_is_agent
    from public.profiles where id = p_profile_id;

  if v_is_agent then
    if p_new_status = 'available' then
      -- Agent becoming available: check if any rotation needs recovery
      perform public._queue_status_agent_available(p_profile_id);
    elsif v_current_status = 'available' then
      -- Agent leaving available: hand off any held turns
      perform public._queue_status_agent_leaving(p_profile_id);
    end if;
  end if;

  return jsonb_build_object(
    'success', true,
    'changed', true,
    'profile_id', p_profile_id,
    'previous_status', v_current_status,
    'status', p_new_status,
    'previous_version', v_current_version,
    'version', v_new_version,
    'source', p_source,
    'changed_by', v_actor
  );
end;
$$;

comment on function public.transition_agent_queue_status(uuid, public.availability_status, text, text, bigint, uuid, uuid, jsonb) is
  'The ONE gateway for all agent queue-status changes. Enforces optimistic concurrency '
  'via version checking, records every transition in agent_queue_status_events, syncs '
  'the legacy profiles.availability mirror, and handles rotation handoffs. '
  'A stale write (wrong expected_version) returns success=false with the current state.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. ROTATION HANDOFF HELPERS — extracted from set_my_availability logic.
--    These are internal helpers called only by transition_agent_queue_status.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Agent becoming available: recover any empty rotations they're eligible for
create or replace function public._queue_status_agent_available(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me       public.profiles%rowtype;
  v_rotation public.rotation_state%rowtype;
  v_eligible boolean;
  v_current  uuid;
  v_started_today boolean;
begin
  select * into v_me from public.profiles where id = p_profile_id;
  if not found then return; end if;

  -- Deterministic lock order across all three rotations
  for v_rotation in select * from public.rotation_state order by kind for update loop
    v_eligible := case
      when v_rotation.kind = 'whatsapp'    then v_me.whatsapp_active
      when v_rotation.kind = 'ringcentral' then v_me.ringcentral_active
      else                                      v_me.workload_active
    end;

    if v_eligible then
      -- Repair a stale or empty pointer first
      perform public.ensure_rotation_valid(v_rotation.kind, v_me.id);

      select current_profile_id into v_current
        from public.rotation_state where kind = v_rotation.kind;

      -- Still empty and this agent is eligible: they start/resume the queue
      if v_current is null
         and public.is_rotation_eligible(v_me.id, v_rotation.kind) then

        select exists (
          select 1 from public.daily_rotation_starts d
          where d.business_date = public.current_business_date()
            and d.rotation = v_rotation.kind
        ) into v_started_today;

        if not v_started_today then
          insert into public.daily_rotation_starts(business_date, rotation, starter_profile_id)
          values (public.current_business_date(), v_rotation.kind, v_me.id)
          on conflict (business_date, rotation) do nothing;
        end if;

        update public.rotation_state
           set current_profile_id = v_me.id,
               version            = version + 1,
               updated_at         = now(),
               updated_by         = v_me.id
         where kind = v_rotation.kind;

        insert into public.turn_events(
          rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason
        ) values (
          v_rotation.kind,
          case when v_started_today then 'auto_skip' else 'daily_start' end,
          v_me.id, null, v_me.id,
          case
            when v_started_today
              then 'Empty queue resumed when an eligible agent became available'
            else 'First eligible agent available for the business day'
          end
        );
      end if;
    end if;
  end loop;
end;
$$;

-- Agent leaving available: hand off any held rotation turns
create or replace function public._queue_status_agent_leaving(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rotation public.rotation_state%rowtype;
begin
  -- Deterministic lock order across all three rotations
  for v_rotation in select * from public.rotation_state order by kind for update loop
    if v_rotation.current_profile_id = p_profile_id then
      perform public.advance_rotation(
        p_rotation       => v_rotation.kind,
        p_actor          => p_profile_id,
        p_after_position => public.rotation_position_of(p_profile_id, v_rotation.kind),
        p_action         => 'auto_skip',
        p_previous       => p_profile_id,
        p_fallback       => null,
        p_work_item_id   => null,
        p_reason         => 'Agent became unavailable'
      );
    end if;
  end loop;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. PUBLIC RPC: set_my_queue_status_v2 — agent changes their own status.
--    Replaces the old set_my_queue_status with version-aware concurrency.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.set_my_queue_status_v2(
  p_status           public.availability_status,
  p_reason           text default null,
  p_expected_version bigint default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_status is null then raise exception 'A queue status is required'; end if;

  return public.transition_agent_queue_status(
    p_profile_id       => v_uid,
    p_new_status       => p_status,
    p_source           => 'agent_manual',
    p_reason           => p_reason,
    p_expected_version => p_expected_version,
    p_changed_by       => v_uid,
    p_metadata         => jsonb_build_object('via', 'set_my_queue_status_v2')
  );
end;
$$;

comment on function public.set_my_queue_status_v2(public.availability_status, text, bigint) is
  'Agent changes their own queue status. Supports optimistic concurrency via p_expected_version. '
  'Returns JSONB with success/failure and current state.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. PUBLIC RPC: manager_set_agent_queue_status — manager overrides agent status.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.manager_set_agent_queue_status(
  p_profile_id uuid,
  p_status     public.availability_status,
  p_reason     text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if not public.is_manager() then raise exception 'Manager permission required'; end if;
  if p_profile_id is null then raise exception 'A profile is required'; end if;
  if p_status is null then raise exception 'A queue status is required'; end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A reason is required';
  end if;

  return public.transition_agent_queue_status(
    p_profile_id       => p_profile_id,
    p_new_status       => p_status,
    p_source           => 'manager_manual',
    p_reason           => p_reason,
    p_changed_by       => v_actor,
    p_metadata         => jsonb_build_object('via', 'manager_set_agent_queue_status', 'manager_id', v_actor)
  );
end;
$$;

comment on function public.manager_set_agent_queue_status(uuid, public.availability_status, text) is
  'Manager overrides an agent''s queue status. Requires a reason. No version check — '
  'manager override always wins.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. REWRITE: set_my_queue_status — backward compatibility wrapper.
--    Old callers still calling set_my_queue_status get routed to the new system.
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
  v_uid    uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;
  if p_status is null then raise exception 'A queue status is required'; end if;

  v_result := public.transition_agent_queue_status(
    p_profile_id       => v_uid,
    p_new_status       => p_status,
    p_source           => 'agent_manual',
    p_reason           => p_reason,
    p_changed_by       => v_uid,
    p_metadata         => jsonb_build_object('via', 'set_my_queue_status_compat')
  );

  -- Return the status as the old API did
  return (v_result->>'status')::public.availability_status;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. REWRITE: apply_queue_status — now delegates to transition_agent_queue_status.
--     This function is called by the attendance functions. Rewriting it here
--     means attendance_break_start/end/clock_out automatically use the new system.
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
  v_result jsonb;
begin
  v_result := public.transition_agent_queue_status(
    p_profile_id       => p_profile_id,
    p_new_status       => p_new_status,
    p_source           => p_source,
    p_reason           => p_reason,
    p_changed_by       => coalesce(p_actor, p_profile_id),
    p_cause_id         => coalesce(p_break_id, p_clock_entry_id),
    p_metadata         => coalesce(p_metadata, '{}'::jsonb)
                          || jsonb_build_object(
                               'clock_entry_id', p_clock_entry_id,
                               'break_id', p_break_id
                             )
  );

  -- Return the new status (matches old API contract)
  return (v_result->>'status')::public.availability_status;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. REWRITE: set_my_availability — the old core writer now delegates too.
--     This keeps claim functions and pass_my_turn working until they are migrated.
--     IMPORTANT: This no longer directly updates profiles.availability — that's
--     done inside transition_agent_queue_status.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.set_my_availability(p_status public.availability_status)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_result jsonb;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;

  -- The daily reset is no longer called here — it is decoupled (see §12).
  -- Delegate to the centralized transition. Source is 'agent_manual' because
  -- this function was historically the manual agent path. If called from
  -- apply_queue_status (attendance), that function already calls
  -- transition_agent_queue_status directly and doesn't come through here.
  v_result := public.transition_agent_queue_status(
    p_profile_id       => v_uid,
    p_new_status       => p_status,
    p_source           => 'agent_manual',
    p_reason           => 'via legacy set_my_availability',
    p_changed_by       => v_uid,
    p_metadata         => jsonb_build_object('via', 'set_my_availability_compat')
  );
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. REWRITE: ensure_daily_availability_reset — uses transition system.
--     Now iterates through agents individually so each gets a proper audit event.
--     Still idempotent (once per business day via availability_day_state).
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.ensure_daily_availability_reset()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $daily_reset$
declare
  v_today              date := public.current_business_date();
  v_last_business_date date;
  v_agent              record;
begin
  perform pg_advisory_xact_lock(707200072);

  insert into public.availability_day_state(singleton_key, business_date, reset_at)
  values (true, v_today, now())
  on conflict (singleton_key) do nothing;

  select business_date
    into v_last_business_date
    from public.availability_day_state
   where singleton_key = true
     for update;

  if v_last_business_date < v_today then
    -- Reset each agent individually through the transition system
    for v_agent in
      select id from public.profiles
       where role::text = 'agent' and is_active
    loop
      -- Use transition function — this creates audit events, syncs legacy mirror,
      -- and handles rotation handoffs (clearing held turns).
      perform public.transition_agent_queue_status(
        p_profile_id  => v_agent.id,
        p_new_status  => 'unavailable'::public.availability_status,
        p_source      => 'daily_reset',
        p_reason      => 'New business day started',
        p_changed_by  => v_agent.id,
        p_metadata    => jsonb_build_object('business_date', v_today)
      );
    end loop;

    -- Clear rotation pointers (transition handles individual handoffs above,
    -- but we still explicitly null them for the daily start semantic)
    update public.rotation_state
       set current_profile_id = null,
           version = version + 1,
           updated_at = now(),
           updated_by = null
     where kind::text in ('whatsapp', 'ringcentral', 'workload');

    -- Mark turn notifications as read
    update public.user_notifications
       set read_at = now()
     where notification_type = 'turn'
       and read_at is null;

    update public.availability_day_state
       set business_date = v_today,
           reset_at = now()
     where singleton_key = true;

    return true;
  end if;

  return false;
end;
$daily_reset$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 13. CRITICAL FIX: attendance_break_end — version-aware restoration.
--
--     The old implementation blindly restored pre_break_queue_status. The new
--     implementation checks whether the queue version changed since the break
--     started. If it did, a newer decision took precedence and break-end does NOT
--     restore the old status.
-- ═══════════════════════════════════════════════════════════════════════════════
-- Add columns to time_clock_breaks for version tracking
alter table public.time_clock_breaks
  add column if not exists queue_version_at_break bigint;

comment on column public.time_clock_breaks.queue_version_at_break is
  'The agent_queue_state.version at the moment this break started the queue transition '
  'to Break. Used by break-end to detect whether a newer decision supersedes restoration. '
  'Null means the break did not change queue status (manual mode or not from Available).';

-- Rewrite attendance_break_start to record the version
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
  v_result       jsonb;
  v_new_version  bigint;
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
      begin
        v_result := public.transition_agent_queue_status(
          p_profile_id  => v_uid,
          p_new_status  => 'break'::public.availability_status,
          p_source      => 'attendance_break_start',
          p_reason      => 'Break started',
          p_cause_id    => v_break_id,
          p_changed_by  => v_uid,
          p_metadata    => jsonb_build_object(
                             'mode', v_mode,
                             'break_type', p_break_type,
                             'clock_entry_id', v_entry_id
                           )
        );

        -- Record the version that the break transition created
        v_new_version := (v_result->>'version')::bigint;
        update public.time_clock_breaks
           set queue_version_at_break = v_new_version
         where id = v_break_id;

        v_queue_after := (v_result->>'status')::public.availability_status;
      exception when others then
        raise exception 'queue_status: %', sqlerrm using errcode = 'QS001';
      end;
      v_changed := v_queue_after is distinct from v_queue;
    end if;
  end if;

  return public.attendance_status_payload(v_uid, false, v_changed, v_already_open);
end;
$$;

-- Rewrite attendance_break_end with the critical version check
create or replace function public.attendance_break_end()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid              uuid := auth.uid();
  v_role             public.app_role;
  v_mode             public.queue_status_mode;
  v_queue            public.availability_status;
  v_entry_id         uuid;
  v_break_minutes    integer;
  v_break_id         uuid;
  v_break_start      timestamptz;
  v_break_type       text;
  v_pre_break        public.availability_status;
  v_version_at_break bigint;
  v_current_version  bigint;
  v_now              timestamptz := now();
  v_duration         integer;
  v_assisted         boolean;
  v_target           public.availability_status;
  v_queue_after      public.availability_status;
  v_changed          boolean := false;
  v_result           jsonb;
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

  if v_entry_id is null then
    return public.attendance_status_payload(v_uid, true, false, false);
  end if;

  select id, break_start, break_type, pre_break_queue_status, queue_version_at_break
    into v_break_id, v_break_start, v_break_type, v_pre_break, v_version_at_break
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
    -- ════════════════════════════════════════════════════════════════════════
    -- CRITICAL CONCURRENCY GUARD:
    -- Do NOT restore pre-break queue state if the queue version changed
    -- after this break placed the agent into Break. A newer manual or
    -- manager decision takes precedence over this automatic restoration.
    -- ════════════════════════════════════════════════════════════════════════
    select version into v_current_version
      from public.agent_queue_state
     where profile_id = v_uid;

    if v_version_at_break is not null and v_current_version is not null
       and v_current_version > v_version_at_break then
      -- Queue state changed since break started — DO NOT restore.
      -- Log that we intentionally skipped restoration.
      insert into public.agent_queue_status_events (
        profile_id, previous_status, new_status, previous_version, new_version,
        source, reason, changed_by, cause_id, metadata
      ) values (
        v_uid, v_queue, v_queue, v_current_version, v_current_version,
        'attendance_break_end', 'Restoration skipped: queue version changed during break',
        v_uid, v_break_id,
        jsonb_build_object(
          'action', 'restoration_skipped',
          'version_at_break', v_version_at_break,
          'current_version', v_current_version,
          'would_have_restored', v_pre_break,
          'break_type', v_break_type
        )
      );
      -- v_changed stays false — no queue mutation occurred
    else
      -- Version unchanged since break started — safe to restore
      v_target := coalesce(v_pre_break, 'unavailable'::public.availability_status);

      begin
        v_result := public.transition_agent_queue_status(
          p_profile_id  => v_uid,
          p_new_status  => v_target,
          p_source      => 'attendance_break_end',
          p_reason      => case
                             when v_pre_break is null then 'Break ended, no pre-break status recorded'
                             else 'Break ended, pre-break status restored'
                           end,
          p_cause_id    => v_break_id,
          p_changed_by  => v_uid,
          p_metadata    => jsonb_build_object(
                             'mode', v_mode,
                             'break_type', v_break_type,
                             'pre_break_queue_status', v_pre_break,
                             'clock_entry_id', v_entry_id
                           )
        );
        v_queue_after := (v_result->>'status')::public.availability_status;
      exception when others then
        raise exception 'queue_status: %', sqlerrm using errcode = 'QS001';
      end;
      v_changed := v_queue_after is distinct from v_queue;
    end if;
  end if;

  return public.attendance_status_payload(v_uid, false, v_changed, false)
         || jsonb_build_object('duration_minutes', v_duration);
end;
$$;

-- Rewrite attendance_clock_out to use transition system directly
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
  v_result        jsonb;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;

  select role, queue_status_mode, availability
    into v_role, v_mode, v_queue
    from public.profiles
   where id = v_uid and is_active;
  if not found then raise exception 'Active profile not found'; end if;

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

  -- End any open break
  update public.time_clock_breaks
     set break_end = v_now, duration_minutes = 0
   where clock_entry_id = v_entry_id and break_end is null
  returning id into v_break_id;

  v_total_hours := round(
    (extract(epoch from (v_now - v_clock_in)) / 3600.0)
    - (coalesce(v_break_minutes, 0) / 60.0),
    2
  );

  update public.time_clock_entries
     set clock_out = v_now,
         clock_status = 'completed',
         total_hours = v_total_hours
   where id = v_entry_id;

  v_assisted := v_role = 'agent'::public.app_role
            and v_mode = 'attendance_assisted'::public.queue_status_mode;

  if v_assisted then
    begin
      v_result := public.transition_agent_queue_status(
        p_profile_id  => v_uid,
        p_new_status  => 'unavailable'::public.availability_status,
        p_source      => 'attendance_clock_out',
        p_reason      => 'Clocked out',
        p_cause_id    => v_entry_id,
        p_changed_by  => v_uid,
        p_metadata    => jsonb_build_object(
                           'mode', v_mode,
                           'had_open_break', v_break_id is not null,
                           'clock_entry_id', v_entry_id
                         )
      );
      v_queue_after := (v_result->>'status')::public.availability_status;
    exception when others then
      raise exception 'queue_status: %', sqlerrm using errcode = 'QS001';
    end;
    v_changed := v_queue_after is distinct from v_queue;
  end if;

  return public.attendance_status_payload(v_uid, false, v_changed, false);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 14. UPDATE ROTATION ELIGIBILITY to read from agent_queue_state.
--     This is the key change: rotations now check the authoritative state.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.next_eligible_profile(
  p_rotation public.rotation_kind,
  p_after_position integer
)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.profiles p
  join public.agent_queue_state aqs on aqs.profile_id = p.id
  where p.is_active
    and p.role = 'agent'
    and aqs.status = 'available'
    and case
      when p_rotation = 'whatsapp'    then p.whatsapp_active
      when p_rotation = 'ringcentral' then p.ringcentral_active
      else                                 p.workload_active
    end
    and case
      when p_rotation = 'whatsapp'    then p.whatsapp_position
      when p_rotation = 'ringcentral' then p.ringcentral_position
      else                                 p.workload_position
    end is not null
  order by
    case
      when (case
              when p_rotation = 'whatsapp'    then p.whatsapp_position
              when p_rotation = 'ringcentral' then p.ringcentral_position
              else                                 p.workload_position
            end) > p_after_position
      then 0 else 1
    end,
    case
      when p_rotation = 'whatsapp'    then p.whatsapp_position
      when p_rotation = 'ringcentral' then p.ringcentral_position
      else                                 p.workload_position
    end,
    p.id
  limit 1;
$$;

create or replace function public.is_rotation_eligible(
  p_profile_id uuid,
  p_rotation public.rotation_kind
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select p.is_active
       and p.role = 'agent'
       and aqs.status = 'available'
       and case
         when p_rotation = 'whatsapp'    then p.whatsapp_active
         when p_rotation = 'ringcentral' then p.ringcentral_active
         else                                 p.workload_active
       end
       and case
         when p_rotation = 'whatsapp'    then p.whatsapp_position
         when p_rotation = 'ringcentral' then p.ringcentral_position
         else                                 p.workload_position
       end is not null
    from public.profiles p
    join public.agent_queue_state aqs on aqs.profile_id = p.id
    where p.id = p_profile_id
  ), false);
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 15. MIGRATION: Seed agent_queue_state from current profiles.availability.
--     This ensures zero disruption during deployment.
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.agent_queue_state (profile_id, status, version, changed_at, changed_by, source, reason)
select
  p.id,
  p.availability,
  1,
  now(),
  p.id,
  'system_migration',
  'Initialized from profiles.availability during v1.19.0 migration'
from public.profiles p
where p.role = 'agent' and p.is_active
on conflict (profile_id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 16. REALTIME PUBLICATION: enable realtime on agent_queue_state.
-- ═══════════════════════════════════════════════════════════════════════════════
alter publication supabase_realtime add table public.agent_queue_state;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 17. RPC to read current queue state (for frontend initialization).
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.get_my_queue_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_state public.agent_queue_state%rowtype;
begin
  if v_uid is null then raise exception 'Authentication required'; end if;

  select * into v_state
    from public.agent_queue_state
   where profile_id = v_uid;

  if not found then
    return jsonb_build_object(
      'profile_id', v_uid,
      'status', 'unavailable',
      'version', 0,
      'source', 'not_initialized'
    );
  end if;

  return jsonb_build_object(
    'profile_id', v_state.profile_id,
    'status', v_state.status,
    'version', v_state.version,
    'changed_at', v_state.changed_at,
    'changed_by', v_state.changed_by,
    'source', v_state.source,
    'reason', v_state.reason
  );
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 18. RPC to read queue status history (for manager diagnostic view).
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.get_agent_queue_status_history(
  p_profile_id uuid,
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_role public.app_role;
  v_events jsonb;
begin
  select role into v_caller_role from public.profiles where id = auth.uid();

  -- Only the agent themselves or a manager/super_admin can view history
  if auth.uid() <> p_profile_id
     and v_caller_role not in ('manager', 'super_admin') then
    raise exception 'Permission denied';
  end if;

  select coalesce(jsonb_agg(row_to_json(e)::jsonb order by e.created_at desc), '[]'::jsonb)
    into v_events
    from (
      select
        ev.id,
        ev.profile_id,
        ev.previous_status,
        ev.new_status,
        ev.previous_version,
        ev.new_version,
        ev.source,
        ev.reason,
        ev.changed_by,
        cb.display_name as changed_by_name,
        ev.cause_id,
        ev.metadata,
        ev.created_at
      from public.agent_queue_status_events ev
      left join public.profiles cb on cb.id = ev.changed_by
      where ev.profile_id = p_profile_id
      order by ev.created_at desc
      limit p_limit
    ) e;

  return v_events;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 19. GRANTS
-- ═══════════════════════════════════════════════════════════════════════════════
-- Internal functions: service_role only
revoke all on function public.transition_agent_queue_status(uuid, public.availability_status, text, text, bigint, uuid, uuid, jsonb) from public;
grant execute on function public.transition_agent_queue_status(uuid, public.availability_status, text, text, bigint, uuid, uuid, jsonb) to service_role;

revoke all on function public._queue_status_agent_available(uuid) from public;
grant execute on function public._queue_status_agent_available(uuid) to service_role;

revoke all on function public._queue_status_agent_leaving(uuid) from public;
grant execute on function public._queue_status_agent_leaving(uuid) to service_role;

-- Public RPCs: authenticated callers
grant execute on function public.set_my_queue_status_v2(public.availability_status, text, bigint) to authenticated, service_role;
grant execute on function public.manager_set_agent_queue_status(uuid, public.availability_status, text) to authenticated, service_role;
grant execute on function public.get_my_queue_state() to authenticated, service_role;
grant execute on function public.get_agent_queue_status_history(uuid, integer) to authenticated, service_role;

-- Backward compatibility wrappers retain existing grants
grant execute on function public.set_my_queue_status(public.availability_status, text) to authenticated, service_role;
grant execute on function public.apply_queue_status(uuid, public.availability_status, text, uuid, uuid, uuid, text, jsonb) to service_role;
grant execute on function public.set_my_availability(public.availability_status) to authenticated, service_role;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 20. REWRITE: admin_deactivate_profile — uses transition_agent_queue_status
--     instead of directly writing profiles.availability.
--
--     The rotation handoff is now handled by the transition function's
--     _queue_status_agent_leaving helper (which advances held turns).
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.admin_deactivate_profile(
  p_profile_id uuid,
  p_manager_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_manager public.profiles%rowtype;
  v_target  public.profiles%rowtype;
  v_active_managers integer;
  v_active_work integer;
  v_pending integer;
begin
  if p_profile_id is null or p_manager_id is null then
    raise exception 'Manager and user IDs are required';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'A deletion reason is required';
  end if;
  if p_profile_id = p_manager_id then
    raise exception 'A manager cannot delete their own account';
  end if;

  select * into v_manager
    from public.profiles
   where id = p_manager_id
     and role in ('manager', 'super_admin')
     and is_active;
  if not found then
    raise exception 'Active manager permission required';
  end if;

  select * into v_target
    from public.profiles
   where id = p_profile_id
     and is_active
     for update;
  if not found then
    raise exception 'Active user not found';
  end if;

  -- Super admin accounts cannot be deleted (super_admin rule)
  if v_target.role = 'super_admin' then
    raise exception 'Super admin accounts cannot be deleted';
  end if;

  if v_target.role = 'manager' then
    select count(*) into v_active_managers
      from public.profiles
     where role = 'manager' and is_active;
    if v_active_managers <= 1 then
      raise exception 'The final active Manager account cannot be deleted';
    end if;
  end if;

  select count(*) into v_active_work
    from public.work_items
   where assigned_profile_id = p_profile_id
     and status = 'active';
  if v_active_work > 0 then
    raise exception 'Reassign or complete this user''s % active work item(s) before deletion', v_active_work;
  end if;

  select count(*) into v_pending
    from public.pending_pricing_quotes
   where assigned_profile_id = p_profile_id;
  if v_pending > 0 then
    raise exception 'Reassign this user''s % Pending Pricing quote(s) before deletion', v_pending;
  end if;

  -- Transition queue status through the centralized system (handles rotation handoffs)
  if v_target.role = 'agent' then
    perform public.transition_agent_queue_status(
      p_profile_id  => p_profile_id,
      p_new_status  => 'unavailable'::public.availability_status,
      p_source      => 'user_deactivated',
      p_reason      => p_reason,
      p_changed_by  => p_manager_id,
      p_metadata    => jsonb_build_object('deactivated_by', p_manager_id)
    );
  end if;

  -- Deactivate the profile
  update public.profiles
     set is_active = false,
         availability = 'unavailable',
         whatsapp_active = false,
         ringcentral_active = false,
         workload_active = false,
         updated_at = now()
   where id = p_profile_id;

  -- Clean up customer service overflow if this was the overflow profile
  update public.work_desk_settings
     set customer_service_overflow_enabled = false,
         customer_service_profile_id = null,
         updated_at = now(),
         updated_by = p_manager_id
   where singleton_id = true
     and customer_service_profile_id = p_profile_id;

  -- Audit
  insert into public.audit_log(
    actor_profile_id, action, entity_type, entity_id, old_value, new_value, reason
  ) values (
    p_manager_id,
    'user_deleted',
    'profile',
    p_profile_id,
    to_jsonb(v_target),
    jsonb_build_object('is_active', false, 'availability', 'unavailable'),
    btrim(p_reason)
  );
end;
$$;

grant execute on function public.admin_deactivate_profile(uuid, uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
select
  (select count(*) from pg_tables where schemaname = 'public' and tablename = 'agent_queue_state') as state_table_exists,
  (select count(*) from pg_tables where schemaname = 'public' and tablename = 'agent_queue_status_events') as events_table_exists,
  (select count(*) from public.agent_queue_state) as migrated_agent_count,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'transition_agent_queue_status') as transition_fn_exists,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_my_queue_status_v2') as v2_rpc_exists,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'manager_set_agent_queue_status') as manager_rpc_exists,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'time_clock_breaks'
      and column_name = 'queue_version_at_break') as break_version_column_exists,
  (select count(*) from pg_trigger where tgname = 'aqse_no_update' and not tgisinternal) as events_immutable_trigger;
