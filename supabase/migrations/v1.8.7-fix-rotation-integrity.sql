-- New Hope Work Desk v1.8.7
-- Queue Rotation Integrity — forward-only repair
--
-- Spec: .kiro/specs/queue-rotation-integrity/
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NAMING NOTE
--   The rotation key 'ringcentral' is a LEGACY INTERNAL LABEL for what the UI
--   calls the "Customer Service Intake Queue". It does NOT imply any external
--   RingCentral integration, API call, credential, or dependency. It is named
--   that way only because intake information historically arrived through
--   customer-service phone calls handled on RingCentral. Database identifiers
--   are intentionally left unchanged here to avoid unnecessary migration risk.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ROOT CAUSE BEING FIXED (RC-1)
--   The deployed next_eligible_profile() moved the position comparison out of
--   ORDER BY and into the WHERE clause:
--
--       WHERE <eligibility> AND <pos> > p_after_position      -- hard filter
--       ORDER BY <pos> LIMIT 1
--
--   That destroys wraparound. The function returns NULL whenever no eligible
--   agent holds a position strictly greater than the current agent's, so:
--     * the highest position never wraps back to the lowest;
--     * a single eligible agent can never be selected (p > p is false);
--     * rotations go NULL, or stick on one agent, while eligible agents exist.
--
--   No migration in supabase/ has ever contained that variant. This migration
--   restores wraparound as an ORDER BY bucket, adds the missing
--   "position is not null" guard, and adds a deterministic id tiebreaker.
--
-- ALSO FIXED
--   RC-2  Unguarded NULL writes into rotation_state.
--   RC-3  No automatic recovery from a NULL or ineligible current agent —
--         including the manager "restore agent to rotation" path, which had no
--         recovery logic at all, and the "remove agent" path, which could leave
--         the rotation pointing at the agent it had just made ineligible.
--   RC-5  Inconsistent eligibility predicates across functions.
--
-- EXPLICITLY UNCHANGED
--   * Workload Pass stays rejected (product policy).
--   * Rotation participation stays agent-only. sales_supervisor / manager keep
--     view + override + manual-assignment powers but never hold a turn, never
--     influence the next-agent calculation, and never pass an agent's turn.
--   * Manual quote / requote, manual workload, payment logging, manager
--     create-and-assign, and manager/manual intake assignment continue to move
--     NO rotation and remain usable without holding a turn.
--   * ensure_daily_availability_reset() still clears all three rotations at the
--     business-date rollover; recovery now happens automatically afterwards.
--   * Recover (steal_timed_quote) still advances from the MISSED agent's
--     position, preserving the documented queue-order rule.
--   * All existing grants are preserved exactly.
--
-- This migration replaces FUNCTIONS ONLY. It contains no INSERT, UPDATE, DELETE,
-- DROP TABLE or TRUNCATE against any data table. No queue state is rewritten:
-- ensure_rotation_valid() repairs each rotation on its next interaction.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 0. Preflight — refuse to install against an unexpected baseline.
-- ═══════════════════════════════════════════════════════════════════════════════
do $preflight$
declare
  v_missing text[] := array[]::text[];
begin
  if to_regclass('public.profiles')       is null then v_missing := array_append(v_missing, 'profiles'); end if;
  if to_regclass('public.rotation_state') is null then v_missing := array_append(v_missing, 'rotation_state'); end if;
  if to_regclass('public.turn_events')    is null then v_missing := array_append(v_missing, 'turn_events'); end if;
  if to_regprocedure('public.next_eligible_profile(public.rotation_kind,integer)') is null
    then v_missing := array_append(v_missing, 'next_eligible_profile(rotation_kind,integer)'); end if;
  if to_regprocedure('public.is_agent()') is null then v_missing := array_append(v_missing, 'is_agent()'); end if;

  if cardinality(v_missing) > 0 then
    raise exception 'v1.8.7 cannot be installed. Missing: %', array_to_string(v_missing, ', ');
  end if;
end
$preflight$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE PRIMARY FIX — restore wraparound in next_eligible_profile.
--
--    Contract:
--      * returns the eligible agent with the smallest position strictly greater
--        than p_after_position;
--      * if none exists, WRAPS to the eligible agent with the smallest position;
--      * if p_after_position is null, returns the lowest-positioned eligible agent;
--      * returns NULL only when the eligible set is empty;
--      * with exactly one eligible agent, always returns that agent;
--      * deterministic when two agents share a position.
--
--    Eligibility (the single definition reused everywhere below):
--      is_active, role = 'agent', availability = 'available',
--      <rotation>_active, and <rotation>_position IS NOT NULL.
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
  where p.is_active
    and p.role = 'agent'
    and p.availability = 'available'
    and case
      when p_rotation = 'whatsapp'    then p.whatsapp_active
      when p_rotation = 'ringcentral' then p.ringcentral_active
      else                                 p.workload_active
    end
    -- RC-5: an agent with no position for this rotation is not eligible.
    and case
      when p_rotation = 'whatsapp'    then p.whatsapp_position
      when p_rotation = 'ringcentral' then p.ringcentral_position
      else                                 p.workload_position
    end is not null
  order by
    -- RC-1: wraparound belongs in ORDER BY, never in WHERE.
    -- Bucket 0 = "after the current position", bucket 1 = "wrapped around".
    -- When p_after_position is null the comparison yields null (not true), so
    -- every row lands in bucket 1 and the lowest position wins.
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
    p.id                                  -- RC-5: deterministic tiebreaker
  limit 1;
$$;

comment on function public.next_eligible_profile(public.rotation_kind, integer) is
  'Resolves the next eligible agent for a rotation, wrapping from the highest position back to the lowest. Returns NULL only when no eligible agent exists. Wraparound MUST stay in ORDER BY: moving it into WHERE reintroduces the v1.8.7 defect.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Shared eligibility predicate, so every caller agrees (RC-5).
-- ═══════════════════════════════════════════════════════════════════════════════
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
       and p.availability = 'available'
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
    where p.id = p_profile_id
  ), false);
$$;

comment on function public.is_rotation_eligible(uuid, public.rotation_kind) is
  'Single source of truth for rotation eligibility: active, role=agent, available, rotation-enabled, and holding a non-null position for that rotation.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Rotation position lookup helper.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.rotation_position_of(
  p_profile_id uuid,
  p_rotation public.rotation_kind
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_rotation = 'whatsapp'    then p.whatsapp_position
    when p_rotation = 'ringcentral' then p.ringcentral_position
    else                                 p.workload_position
  end
  from public.profiles p
  where p.id = p_profile_id;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Human-readable explanation for an empty queue.
--    Replaces one generic "No agent available" message with the real reason.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.rotation_empty_reason(
  p_rotation public.rotation_kind
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_label      text;
  v_enabled    integer;
  v_available  integer;
  v_positioned integer;
begin
  v_label := case
    when p_rotation = 'whatsapp'    then 'WhatsApp'
    when p_rotation = 'ringcentral' then 'Customer Service Intake Queue'
    else                                 'Additional Workload'
  end;

  select
    count(*) filter (where enabled),
    count(*) filter (where enabled and avail),
    count(*) filter (where enabled and avail and positioned)
  into v_enabled, v_available, v_positioned
  from (
    select
      p.is_active and p.role = 'agent' and case
        when p_rotation = 'whatsapp'    then p.whatsapp_active
        when p_rotation = 'ringcentral' then p.ringcentral_active
        else                                 p.workload_active
      end as enabled,
      p.availability = 'available' as avail,
      case
        when p_rotation = 'whatsapp'    then p.whatsapp_position
        when p_rotation = 'ringcentral' then p.ringcentral_position
        else                                 p.workload_position
      end is not null as positioned
    from public.profiles p
    where p.is_active
  ) s;

  if v_enabled = 0 then
    return format('No agents are assigned to the %s queue.', v_label);
  elsif v_available = 0 then
    return format('All %s %s agents are unavailable or on break.', v_enabled, v_label);
  elsif v_positioned = 0 then
    return format('%s %s agents are available but have no queue position set.', v_available, v_label);
  else
    return format('Queue state is inconsistent: %s eligible %s agent(s) exist but no agent holds the turn.', v_positioned, v_label);
  end if;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. advance_rotation — the single place a turn is consumed.
--
--    The CALLER MUST already hold the row lock:
--        select * from public.rotation_state where kind = <k> for update;
--
--    Guarantees:
--      * resolves the next agent inside the caller's transaction;
--      * never writes NULL while an eligible fallback exists (invariant 10);
--      * increments version exactly once;
--      * writes exactly ONE turn_events row;
--      * touches only the named rotation (invariant 1).
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.advance_rotation(
  p_rotation        public.rotation_kind,
  p_actor           uuid,
  p_after_position  integer,
  p_action          text,
  p_previous        uuid    default null,
  p_fallback        uuid    default null,
  p_work_item_id    uuid    default null,
  p_reason          text    default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next     uuid;
  v_previous uuid;
  v_reason   text := p_reason;
begin
  if p_action not in ('claim', 'pass', 'manual_change', 'auto_skip', 'daily_start') then
    raise exception 'Invalid turn action: %', p_action;
  end if;

  select current_profile_id into v_previous
  from public.rotation_state
  where kind = p_rotation;

  if p_previous is not null then
    v_previous := p_previous;
  end if;

  v_next := public.next_eligible_profile(p_rotation, p_after_position);

  -- Invariant 10 / invariant 3: never null out a live queue. Prefer the caller's
  -- explicit fallback, then the actor, provided they are still eligible.
  if v_next is null then
    if p_fallback is not null and public.is_rotation_eligible(p_fallback, p_rotation) then
      v_next := p_fallback;
    elsif p_actor is not null and public.is_rotation_eligible(p_actor, p_rotation) then
      v_next := p_actor;
    end if;
  end if;

  -- Invariant 6: with genuinely no eligible agents, NULL is correct — but say why.
  if v_next is null then
    v_reason := coalesce(v_reason || ' — ', '') || public.rotation_empty_reason(p_rotation);
  end if;

  update public.rotation_state
  set current_profile_id = v_next,
      version            = version + 1,
      updated_at         = now(),
      updated_by         = p_actor
  where kind = p_rotation;

  insert into public.turn_events(
    rotation, action, actor_profile_id, previous_profile_id,
    next_profile_id, work_item_id, reason
  ) values (
    p_rotation, p_action, p_actor, v_previous, v_next, p_work_item_id, v_reason
  );

  return v_next;
end;
$$;

comment on function public.advance_rotation(public.rotation_kind, uuid, integer, text, uuid, uuid, uuid, text) is
  'Consumes one turn: resolves the next eligible agent with wraparound, keeps the turn with an eligible fallback instead of writing NULL, bumps version once, and writes exactly one turn_events row. Caller must hold the rotation_state row lock.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. ensure_rotation_valid — idempotent self-healing (RC-3).
--
--    Repairs a rotation whose current agent went ineligible, or which is NULL
--    while eligible agents exist. Safe to call at the start of any rotation
--    action: it writes nothing and logs nothing when the state is already valid.
--
--    The CALLER MUST already hold the rotation_state row lock.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.ensure_rotation_valid(
  p_rotation public.rotation_kind,
  p_actor    uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current  uuid;
  v_next     uuid;
  v_from_pos integer;
begin
  select current_profile_id into v_current
  from public.rotation_state
  where kind = p_rotation;

  -- Already valid: do nothing at all.
  if v_current is not null and public.is_rotation_eligible(v_current, p_rotation) then
    return v_current;
  end if;

  -- Resume from the stale agent's position when known, so the queue keeps its
  -- place rather than restarting at the lowest position.
  if v_current is not null then
    v_from_pos := public.rotation_position_of(v_current, p_rotation);
  end if;

  v_next := public.next_eligible_profile(p_rotation, v_from_pos);

  if v_next is null then
    -- No eligible agents. NULL is legitimate (invariant 6). Only record a
    -- transition if we are actually changing the stored value.
    if v_current is null then
      return null;
    end if;

    update public.rotation_state
    set current_profile_id = null,
        version            = version + 1,
        updated_at         = now(),
        updated_by         = p_actor
    where kind = p_rotation;

    insert into public.turn_events(
      rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason
    ) values (
      p_rotation, 'auto_skip', p_actor, v_current, null,
      'Current agent was no longer eligible. ' || public.rotation_empty_reason(p_rotation)
    );
    return null;
  end if;

  if v_next = v_current then
    return v_current;
  end if;

  update public.rotation_state
  set current_profile_id = v_next,
      version            = version + 1,
      updated_at         = now(),
      updated_by         = p_actor
  where kind = p_rotation;

  insert into public.turn_events(
    rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason
  ) values (
    p_rotation, 'auto_skip', p_actor, v_current, v_next,
    case
      when v_current is null
        then 'Empty queue recovered automatically because an eligible agent was available'
      else 'Current agent was no longer eligible; queue advanced automatically'
    end
  );

  return v_next;
end;
$$;

comment on function public.ensure_rotation_valid(public.rotation_kind, uuid) is
  'Idempotent repair for a NULL or ineligible current agent. Satisfies the rule that a rotation must never stay empty while an eligible agent exists, without a manager fixing it by hand. Caller must hold the rotation_state row lock.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. pass_my_turn — self-loop instead of a hard failure.
--
--    Changes:
--      * removed `if v_next is null then raise exception 'No eligible next agent'`
--        so a sole eligible agent keeps the turn (approved decision 3);
--      * repairs a stale pointer before validating ownership;
--      * advancement, version bump and audit go through advance_rotation.
--
--    Unchanged: workload passes are still rejected; a reason is still required;
--    only the current eligible agent may pass their own turn.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.pass_my_turn(
  p_rotation public.rotation_kind,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me    public.profiles%rowtype;
  v_state public.rotation_state%rowtype;
  v_next  uuid;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;

  if p_rotation = 'workload' then
    raise exception 'Additional Workload turns cannot be passed. Take the task and use Customer Service overflow after acceptance when needed.';
  end if;

  if nullif(trim(p_reason), '') is null then
    raise exception 'A pass reason is required';
  end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;

  -- Lock order: profiles, then the single rotation_state row.
  select * into v_state from public.rotation_state where kind = p_rotation for update;
  if not found then raise exception 'Queue is not initialized'; end if;

  perform public.ensure_rotation_valid(p_rotation, v_me.id);

  select * into v_state from public.rotation_state where kind = p_rotation;

  -- Revalidate after locking (the caller may have lost eligibility meanwhile).
  if not public.is_rotation_eligible(v_me.id, p_rotation) then
    raise exception 'Set your status to Available and confirm you are active in this queue before passing';
  end if;

  if v_state.current_profile_id is distinct from v_me.id then
    raise exception 'This turn belongs to another agent';
  end if;

  v_next := public.advance_rotation(
    p_rotation       => p_rotation,
    p_actor          => v_me.id,
    p_after_position => public.rotation_position_of(v_me.id, p_rotation),
    p_action         => 'pass',
    p_previous       => v_me.id,
    p_fallback       => v_me.id,
    p_work_item_id   => null,
    p_reason         => btrim(p_reason)
  );

  return v_next;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. set_my_availability — auto-recovery on return, guarded advance on leave.
--
--    Changes:
--      * the available branch repairs a NULL or ineligible pointer for every
--        rotation the agent is enabled for, then starts the queue if still empty;
--      * the non-available branch advances through advance_rotation, so it can
--        no longer strand a rotation at NULL while eligible agents remain, and
--        the logged reason states the real cause.
--
--    Unchanged: the daily reset still runs first and still clears all three
--    rotations at the business-date rollover.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.set_my_availability(p_status public.availability_status)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me            public.profiles%rowtype;
  v_rotation      public.rotation_state%rowtype;
  v_eligible      boolean;
  v_started_today boolean;
  v_current       uuid;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;

  perform public.ensure_daily_availability_reset();

  select * into v_me from public.profiles where id = auth.uid() and is_active for update;
  if not found then raise exception 'Active profile not found'; end if;

  update public.profiles set availability = p_status where id = v_me.id;

  -- Deterministic lock order across all three rotations.
  for v_rotation in select * from public.rotation_state order by kind for update loop

    v_eligible := case
      when v_rotation.kind = 'whatsapp'    then v_me.whatsapp_active
      when v_rotation.kind = 'ringcentral' then v_me.ringcentral_active
      else                                      v_me.workload_active
    end;

    if p_status = 'available' then
      if v_eligible then
        -- Repair a stale or empty pointer first.
        perform public.ensure_rotation_valid(v_rotation.kind, v_me.id);

        select current_profile_id into v_current
        from public.rotation_state where kind = v_rotation.kind;

        -- Still empty and this agent is eligible: they start the queue.
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

    else
      -- Going unavailable / on break: hand off only the rotations this agent holds.
      if v_rotation.current_profile_id = v_me.id then
        perform public.advance_rotation(
          p_rotation       => v_rotation.kind,
          p_actor          => v_me.id,
          p_after_position => public.rotation_position_of(v_me.id, v_rotation.kind),
          p_action         => 'auto_skip',
          p_previous       => v_me.id,
          p_fallback       => null,   -- the actor is no longer eligible
          p_work_item_id   => null,
          p_reason         => 'Agent became unavailable'
        );
      end if;
    end if;
  end loop;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. manager_set_rotation_eligibility — recover on BOTH branches (RC-3).
--
--    Before: the repair block sat inside `if not p_active then`, and even there
--    it only ran when `v_next is not null and v_next <> p_profile_id`. So
--      * restoring an agent to a NULL rotation left it NULL forever, and
--      * removing the only eligible agent left the rotation pointing at them,
--        deadlocking the queue for everyone.
--
--    After: ensure_rotation_valid runs on both branches and handles every case.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.manager_set_rotation_eligibility(
  p_profile_id uuid,
  p_rotation public.rotation_kind,
  p_active boolean,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old     jsonb;
  v_profile public.profiles%rowtype;
begin
  if not public.can_manage_sales() then raise exception 'Manager permission required'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'A reason is required'; end if;

  select * into v_profile from public.profiles where id = p_profile_id for update;
  if not found or v_profile.role <> 'agent' then
    raise exception 'Active agent not found';
  end if;

  v_old := to_jsonb(v_profile);

  if p_rotation = 'whatsapp' then
    update public.profiles set whatsapp_active = p_active where id = p_profile_id;
  elsif p_rotation = 'ringcentral' then
    update public.profiles set ringcentral_active = p_active where id = p_profile_id;
  else
    update public.profiles set workload_active = p_active where id = p_profile_id;
  end if;

  -- Lock the affected rotation, then repair it. Runs whether we removed or
  -- restored the agent, and touches no other rotation.
  perform 1 from public.rotation_state where kind = p_rotation for update;
  perform public.ensure_rotation_valid(p_rotation, auth.uid());

  insert into public.audit_log(
    actor_profile_id, action, entity_type, entity_id, old_value, new_value, reason
  )
  select auth.uid(), 'rotation_eligibility_changed', 'profile', p_profile_id,
         v_old, to_jsonb(p), p_reason
  from public.profiles p where p.id = p_profile_id;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. claim_timed_quote — guarded advance (RC-2).
--     Body preserved from production; only the advancement block changed.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.claim_timed_quote(p_timer_id uuid)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_timer   public.quote_take_timers%rowtype;
  v_state   public.rotation_state%rowtype;
  v_current public.profiles%rowtype;
  v_item    public.work_items%rowtype;
  v_elapsed integer;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;

  select * into v_timer from public.quote_take_timers where id = p_timer_id for update;
  if not found or v_timer.status <> 'active' then
    raise exception 'This rescue timer is no longer active';
  end if;
  if v_timer.current_profile_id <> auth.uid() then
    raise exception 'This timed quote belongs to the current queue agent';
  end if;

  select * into v_state from public.rotation_state where kind = v_timer.rotation for update;
  if v_state.current_profile_id is distinct from v_timer.current_profile_id then
    raise exception 'The queue moved and this timer is no longer valid';
  end if;

  select * into v_current from public.profiles
  where id = v_timer.current_profile_id and role = 'agent' and is_active;
  if not found then raise exception 'Current agent profile is invalid'; end if;

  insert into public.work_items(
    customer_name, dealer_id, work_type, assigned_profile_id, assignment_method,
    status, note, received_through, created_by, assigned_at, accepted_at
  ) values (
    v_timer.customer_name, v_timer.dealer_id, v_timer.work_type, v_current.id,
    case when v_timer.rotation = 'whatsapp'
      then 'whatsapp_turn'::public.assignment_method
      else 'ringcentral_turn'::public.assignment_method end,
    'active', v_timer.note,
    case when v_timer.rotation = 'whatsapp' then 'WhatsApp dealership' else 'RingCentral' end,
    v_current.id, now(), now()
  ) returning * into v_item;

  v_elapsed := greatest(0, floor(extract(epoch from (now() - v_timer.received_at)))::integer);

  update public.quote_take_timers
  set status = 'claimed', claimed_by_profile_id = v_current.id,
      source_work_item_id = v_item.id, completed_at = now()
  where id = v_timer.id;

  perform public.add_quote_note_if_present(v_item.id, v_current.id, v_timer.note);

  insert into public.work_item_events(
    source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at
  ) values (
    v_item.id, 'timer_claimed', v_current.id, v_current.id,
    jsonb_build_object('timer_id', v_timer.id, 'received_at', v_timer.received_at,
                       'elapsed_seconds', v_elapsed),
    now()
  );

  -- CHANGED: advance through the guarded helper so a sole eligible agent keeps
  -- the turn instead of the rotation being nulled.
  perform public.advance_rotation(
    p_rotation       => v_timer.rotation,
    p_actor          => v_current.id,
    p_after_position => public.rotation_position_of(v_current.id, v_timer.rotation),
    p_action         => 'claim',
    p_previous       => v_current.id,
    p_fallback       => v_current.id,
    p_work_item_id   => v_item.id,
    p_reason         => 'Current agent responded to rescue timer'
  );

  return v_item;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. steal_timed_quote ("Recover") — guarded advance (RC-2).
--
--     The documented rule is preserved exactly: advancement is computed from the
--     MISSED agent's position, so only that agent's turn is consumed and the
--     normal queue position is not reset. Only the write is now guarded.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.steal_timed_quote(p_timer_id uuid)
returns public.work_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_timer   public.quote_take_timers%rowtype;
  v_state   public.rotation_state%rowtype;
  v_current public.profiles%rowtype;
  v_me      public.profiles%rowtype;
  v_item    public.work_items%rowtype;
  v_elapsed integer;
begin
  if not public.is_agent() then raise exception 'Agent permission required'; end if;

  select * into v_timer from public.quote_take_timers where id = p_timer_id for update;
  if not found or v_timer.status <> 'active' then
    raise exception 'This rescue timer is no longer active';
  end if;
  if v_timer.deadline_at > now() then
    raise exception 'The current agent still has time remaining';
  end if;
  if v_timer.current_profile_id = auth.uid() then
    raise exception 'You own this turn. Use Take Timed Quote instead';
  end if;

  select * into v_me from public.profiles
  where id = auth.uid() and role = 'agent' and is_active for update;
  if not found then raise exception 'Active agent profile not found'; end if;
  if v_me.availability <> 'available' then
    raise exception 'Set your status to Available before recovering a quote';
  end if;
  if v_timer.rotation = 'whatsapp' and not v_me.whatsapp_active then
    raise exception 'You are paused from the WhatsApp queue';
  end if;
  if v_timer.rotation = 'ringcentral' and not v_me.ringcentral_active then
    raise exception 'You are paused from the Customer Service Intake Queue';
  end if;

  select * into v_state from public.rotation_state where kind = v_timer.rotation for update;
  if v_state.current_profile_id is distinct from v_timer.current_profile_id then
    raise exception 'The queue moved and this timer is no longer valid';
  end if;

  select * into v_current from public.profiles
  where id = v_timer.current_profile_id and role = 'agent' and is_active;
  if not found then raise exception 'The missed agent profile is invalid'; end if;

  insert into public.work_items(
    customer_name, dealer_id, work_type, assigned_profile_id, assignment_method,
    status, note, received_through, created_by, assigned_at, accepted_at
  ) values (
    v_timer.customer_name, v_timer.dealer_id, v_timer.work_type, v_me.id,
    case when v_timer.rotation = 'whatsapp'
      then 'whatsapp_turn'::public.assignment_method
      else 'ringcentral_turn'::public.assignment_method end,
    'active', v_timer.note,
    case when v_timer.rotation = 'whatsapp' then 'WhatsApp dealership' else 'RingCentral' end,
    v_me.id, now(), now()
  ) returning * into v_item;

  v_elapsed := greatest(0, floor(extract(epoch from (now() - v_timer.received_at)))::integer);

  update public.quote_take_timers
  set status = 'stolen', claimed_by_profile_id = v_me.id,
      source_work_item_id = v_item.id, completed_at = now()
  where id = v_timer.id;

  insert into public.quote_take_events(
    source_work_item_id, rotation, received_at, taken_at,
    taker_profile_id, skipped_profile_ids, elapsed_seconds
  ) values (
    v_item.id, v_timer.rotation, v_timer.received_at, now(),
    v_me.id, array[v_current.id]::uuid[], v_elapsed
  );

  perform public.add_quote_note_if_present(v_item.id, v_me.id, v_timer.note);

  insert into public.work_item_events(
    source_work_item_id, event_type, actor_profile_id, assigned_profile_id, details, created_at
  ) values (
    v_item.id, 'taken', v_me.id, v_me.id,
    jsonb_build_object(
      'timer_id', v_timer.id,
      'rotation', v_timer.rotation,
      'received_at', v_timer.received_at,
      'elapsed_seconds', v_elapsed,
      'missed_profile_id', v_current.id,
      'skipped_profile_ids', to_jsonb(array[v_current.id]::uuid[])
    ),
    now()
  );

  -- Preserve queue order: advance from the agent whose turn expired, NOT from
  -- the recovering agent. Guarded so it cannot null a live queue.
  perform public.advance_rotation(
    p_rotation       => v_timer.rotation,
    p_actor          => v_me.id,
    p_after_position => public.rotation_position_of(v_current.id, v_timer.rotation),
    p_action         => 'claim',
    p_previous       => v_current.id,
    p_fallback       => null,
    p_work_item_id   => v_item.id,
    p_reason         => format('Quote recovered after %s seconds; missed current agent %s',
                               v_elapsed, v_current.display_name)
  );

  insert into public.user_notifications(
    recipient_profile_id, notification_type, title, message, entity_type, entity_id
  ) values (
    v_current.id, 'turn', 'Quote was recovered',
    format('%s took %s after your 3-minute response period expired. Your turn was consumed and the regular queue order was preserved.',
           v_me.display_name, v_timer.customer_name),
    'work_item', v_item.id
  );

  return v_item;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. Grants — restored exactly as they were before this migration.
--     next_eligible_profile keeps its pre-existing broader grant set so this
--     migration changes no authorization surface.
-- ═══════════════════════════════════════════════════════════════════════════════
grant execute on function public.next_eligible_profile(public.rotation_kind, integer) to anon, authenticated, service_role;

grant execute on function public.is_rotation_eligible(uuid, public.rotation_kind)   to authenticated, service_role;
grant execute on function public.rotation_position_of(uuid, public.rotation_kind)   to authenticated, service_role;
grant execute on function public.rotation_empty_reason(public.rotation_kind)        to authenticated, service_role;

-- Internal transition helpers: not callable by end users. Rotation changes must
-- go through the audited action functions, never directly.
revoke all on function public.advance_rotation(public.rotation_kind, uuid, integer, text, uuid, uuid, uuid, text) from public;
revoke all on function public.ensure_rotation_valid(public.rotation_kind, uuid) from public;
grant execute on function public.advance_rotation(public.rotation_kind, uuid, integer, text, uuid, uuid, uuid, text) to service_role;
grant execute on function public.ensure_rotation_valid(public.rotation_kind, uuid) to service_role;

grant execute on function public.pass_my_turn(public.rotation_kind, text)                                to authenticated, service_role;
grant execute on function public.set_my_availability(public.availability_status)                          to authenticated, service_role;
grant execute on function public.manager_set_rotation_eligibility(uuid, public.rotation_kind, boolean, text) to authenticated, service_role;
grant execute on function public.claim_timed_quote(uuid)                                                  to authenticated, service_role;
grant execute on function public.steal_timed_quote(uuid)                                                  to authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 13. Post-install verification. Fails the transaction if the fix did not land.
-- ═══════════════════════════════════════════════════════════════════════════════
do $verify$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'next_eligible_profile';

  -- Wraparound must be an ORDER BY bucket.
  if v_def !~* 'order by[\s\S]*case[\s\S]*>\s*p_after_position' then
    raise exception 'v1.8.7 verification failed: wraparound is not in ORDER BY';
  end if;

  -- The position comparison must NOT be a WHERE predicate (the RC-1 shape).
  if v_def ~* 'and\s+case[\s\S]*>\s*p_after_position[\s\S]*(\n|\s)order by' then
    raise exception 'v1.8.7 verification failed: position filter is still in WHERE';
  end if;

  if v_def !~* 'is not null' then
    raise exception 'v1.8.7 verification failed: null-position guard missing';
  end if;

  if to_regprocedure('public.advance_rotation(public.rotation_kind,uuid,integer,text,uuid,uuid,uuid,text)') is null then
    raise exception 'v1.8.7 verification failed: advance_rotation missing';
  end if;

  if to_regprocedure('public.ensure_rotation_valid(public.rotation_kind,uuid)') is null then
    raise exception 'v1.8.7 verification failed: ensure_rotation_valid missing';
  end if;

  raise notice 'v1.8.7 installed: rotation wraparound restored, self-healing enabled.';
end
$verify$;

commit;
