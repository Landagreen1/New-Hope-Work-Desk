-- New Hope Work Desk v1.11.2 — Walk-in intakes are served out of turn
--
-- Refines the rule shipped in v1.11.0. Business decision from Byron:
--
--   A walk-in customer is standing in the office, so an authorized walk-in agent
--   must be able to take them immediately.
--
--     * If it IS that agent's RingCentral turn, the claim consumes and advances
--       the RingCentral rotation exactly once — identical to today's behaviour.
--       They do not get a free extra quote just because it was a walk-in.
--     * If it is SOMEONE ELSE'S turn, they may still claim it, and the queue
--       order must not change at all. The other agent keeps their turn.
--
-- Only `public.cs_intake_claim_ringcentral(uuid)` changes. No table, column,
-- index, policy, or row is touched.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS DOES NOT VIOLATE THE QUEUE ROTATION RULES
-- ─────────────────────────────────────────────────────────────────────────────
--   The project rule is that "a successful normal RingCentral quote claim
--   consumes and advances only the RingCentral turn". An out-of-turn walk-in is
--   not a normal queue claim — it is closer to `cs_intake_manager_assign`, which
--   already assigns work without consuming a turn. So the out-of-turn branch
--   deliberately behaves like the non-consuming family:
--
--     * `rotation_state` is READ (and locked) but never written.
--     * NO `turn_events` row is inserted. turn_events is the queue's audit log;
--       writing a 'claim' row for a transition that did not happen would corrupt
--       `daily_agent_performance.workload_turns`-style counts and mislead anyone
--       reading the rotation history.
--     * The audit trail lives in `cs_intake_events` and `work_item_events`
--       instead, with an explicit `consumed_turn` flag on both, so a walk-in that
--       skipped the queue is always distinguishable after the fact.
--
--   `rotation_state` is still locked FOR UPDATE before the branch is chosen. That
--   is what makes the decision race-free: without the lock, a concurrent normal
--   claim could advance the turn between reading `current_profile_id` and acting
--   on it, and the same walk-in could be treated as both in-turn and out-of-turn.
--   Taking a lock and not writing is harmless and is the cheapest correct option.
--
--   Invariants preserved verbatim: the idempotency return still comes first, so a
--   browser retry of a committed walk-in claim returns the same work item and
--   cannot advance anything a second time; a refusal still writes nothing; and a
--   non-walk-in intake still requires the current turn holder.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ELIGIBILITY, AND WHY IT DIFFERS BETWEEN THE TWO BRANCHES
-- ─────────────────────────────────────────────────────────────────────────────
--   Normal claim (unchanged): `availability = 'available'` AND `ringcentral_active`.
--
--   Walk-in: `availability = 'available'` only. `ringcentral_active` is
--   deliberately NOT required, because it governs rotation membership, and an
--   out-of-turn walk-in claim does not use the rotation. Requiring it would mean
--   an authorized walk-in agent who has RingCentral switched off could never take
--   a walk-in, which is the opposite of the intent. Availability is still required
--   because an agent who is not clocked in cannot serve a customer in the lobby.
--
--   The turn is consumed only when the caller holds it AND is a valid rotation
--   member (`ringcentral_active` and a non-null `ringcentral_position`). In a
--   healthy database holding the turn already implies both — `next_eligible_profile`
--   and `set_my_availability` maintain that. The belt-and-braces check exists so
--   that if the rotation is ever in an inconsistent state, this function declines
--   to advance from an undefined position rather than computing a wrong next agent.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- REPORTING
-- ─────────────────────────────────────────────────────────────────────────────
--   `assignment_method` stays 'ringcentral_turn' in both branches, on purpose.
--   `daily_agent_performance.ringcentral_quotes` counts work items by that value,
--   so the agent still gets credit for the quote they actually produced. Turn
--   counts are derived from `turn_events`, which the out-of-turn branch does not
--   write, so no phantom turn appears anywhere.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
--   Re-apply the `cs_intake_claim_ringcentral` definition from
--   supabase/migrations/v1.11.0-walk-in-claim-eligibility.sql. That restores the
--   strict "walk-ins still wait for the turn" behaviour. Nothing else to undo.

begin;

set local lock_timeout = '5s';

create or replace function public.cs_intake_claim_ringcentral(p_submission_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles%rowtype;
  v_state public.rotation_state%rowtype;
  v_row public.cs_intake_submissions%rowtype;
  v_next uuid;
  v_work_item_id uuid;
  v_was_already_claimed boolean := false;
  v_is_walk_in boolean := false;
  v_holds_turn boolean := false;
  v_consumes_turn boolean := false;
begin
  if not public.is_agent() then
    raise exception 'Agent permission required.';
  end if;

  select *
  into v_me
  from public.profiles
  where id = auth.uid()
    and is_active
  for update;

  if not found then
    raise exception 'Active agent profile not found.';
  end if;

  select *
  into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Intake not found.';
  end if;

  -- Idempotency FIRST. A retry after a successful commit must return the existing
  -- work item, whether or not the turn has since moved.
  if v_row.status::text = 'converted'
     and v_row.work_item_id is not null then
    if v_row.claimed_by = v_me.id then
      return v_row.work_item_id;
    end if;
    raise exception 'This intake was already converted by another agent.';
  end if;

  if v_row.intake_channel <> 'ringcentral' then
    raise exception 'This intake is manager/manual assigned and does not use the RingCentral turn.';
  end if;

  v_is_walk_in := coalesce(v_row.is_walk_in, false);

  -- v1.11.0: walk-in customers are handled only by the designated walk-in agents.
  if v_is_walk_in and not coalesce(v_me.can_claim_walk_in, false) then
    raise exception 'This is a walk-in customer. Only % can take walk-in intakes.',
      coalesce(nullif(public.walk_in_claimer_names(), ''), 'the designated walk-in agents');
  end if;

  if v_row.status::text = 'claimed'
     and v_row.claimed_by = v_me.id
     and v_row.work_item_id is null then
    -- Recovery path for rows stranded by the old Claim-only button.
    v_was_already_claimed := true;
  elsif v_row.status::text <> 'submitted' then
    raise exception 'This intake is no longer available to claim.';
  end if;

  -- Lock the rotation BEFORE deciding whether this claim consumes a turn, so a
  -- concurrent normal claim cannot move the turn out from under the decision.
  select *
  into v_state
  from public.rotation_state
  where kind::text = 'ringcentral'
  for update;

  if not found then
    raise exception 'RingCentral rotation state is missing.';
  end if;

  v_holds_turn := v_state.current_profile_id is not null
                  and v_state.current_profile_id = v_me.id;

  if v_is_walk_in then
    -- v1.11.2: the customer is in the office, so serve them now regardless of
    -- whose turn it is. Being clocked in is the only requirement.
    if v_me.availability::text <> 'available' then
      raise exception 'Mark yourself Available before taking a walk-in customer.';
    end if;

    -- Consume the turn only when it genuinely is this agent's turn AND their
    -- rotation position is well defined, so advancing from it is unambiguous.
    v_consumes_turn := v_holds_turn
                       and coalesce(v_me.ringcentral_active, false)
                       and v_me.ringcentral_position is not null;
  else
    -- Normal RingCentral intake: unchanged in every respect.
    if v_me.availability::text <> 'available'
       or not coalesce(v_me.ringcentral_active, false) then
      raise exception 'You are not eligible for the RingCentral rotation.';
    end if;

    if not v_holds_turn then
      raise exception 'This RingCentral turn belongs to another agent.';
    end if;

    v_consumes_turn := true;
  end if;

  if not v_was_already_claimed then
    update public.cs_intake_submissions
    set status = 'claimed',
        claimed_by = v_me.id,
        claimed_at = now(),
        updated_at = now()
    where id = p_submission_id
      and status::text = 'submitted';

    if not found then
      raise exception 'Another agent claimed this intake first.';
    end if;

    insert into public.cs_intake_events (
      submission_id,
      actor_id,
      event_type,
      detail
    )
    values (
      p_submission_id,
      v_me.id,
      case
        when v_is_walk_in and not v_consumes_turn then 'walk_in_claimed_out_of_turn'
        when v_is_walk_in then 'walk_in_claimed_on_turn'
        else 'ringcentral_claimed'
      end,
      jsonb_build_object(
        'rotation_version', v_state.version,
        'intake_channel', 'ringcentral',
        'is_walk_in', v_is_walk_in,
        'held_turn', v_holds_turn,
        'consumed_turn', v_consumes_turn,
        'turn_holder_at_claim', v_state.current_profile_id
      )
    );
  else
    insert into public.cs_intake_events (
      submission_id,
      actor_id,
      event_type,
      detail
    )
    values (
      p_submission_id,
      v_me.id,
      'ringcentral_claim_recovered',
      jsonb_build_object(
        'rotation_version', v_state.version,
        'reason', 'Recovered from the previous claim-only workflow',
        'is_walk_in', v_is_walk_in,
        'held_turn', v_holds_turn,
        'consumed_turn', v_consumes_turn
      )
    );
  end if;

  -- Reuse the verified structured-intake converter.
  v_work_item_id := public.cs_intake_convert(p_submission_id);

  -- Make the resulting task semantically identical to Take RC Quote.
  -- assignment_method stays 'ringcentral_turn' in both branches so the agent gets
  -- credit for the quote in daily_agent_performance; turn counts come from
  -- turn_events, which the out-of-turn branch never writes.
  update public.work_items
  set assignment_method = 'ringcentral_turn',
      received_through = case
        when v_is_walk_in then 'Walk-in / Customer Service intake'
        else 'RingCentral / Customer Service intake'
      end,
      accepted_at = coalesce(accepted_at, now()),
      note = concat_ws(
        E'\n',
        nullif(note, ''),
        case
          when v_is_walk_in and not v_consumes_turn then
            'Walk-in customer taken out of turn from the Customer Service Intake Queue. The RingCentral queue order was not changed.'
          when v_is_walk_in then
            'Walk-in customer claimed from the Customer Service Intake Queue during this agent''s RingCentral turn.'
          else
            'Claimed from the Customer Service Intake Queue during the RingCentral turn.'
        end
      ),
      updated_at = now()
  where id = v_work_item_id
    and assigned_profile_id = v_me.id;

  if not found then
    raise exception 'The intake converted, but its active Work Desk task could not be linked.';
  end if;

  insert into public.work_item_events (
    source_work_item_id,
    event_type,
    actor_profile_id,
    assigned_profile_id,
    details
  )
  values (
    v_work_item_id,
    case
      when v_is_walk_in and not v_consumes_turn then 'walk_in_intake_claim_out_of_turn'
      else 'ringcentral_intake_claim_completed'
    end,
    v_me.id,
    v_me.id,
    jsonb_build_object(
      'intake_id', p_submission_id,
      'quote_kind', v_row.quote_kind,
      'line_of_business', v_row.line_of_business::text,
      'rotation_version_before', v_state.version,
      'recovered_existing_claim', v_was_already_claimed,
      'is_walk_in', v_is_walk_in,
      'held_turn', v_holds_turn,
      'consumed_turn', v_consumes_turn,
      'turn_holder_at_claim', v_state.current_profile_id
    )
  );

  -- ── The only place the rotation is written ────────────────────────────────
  if v_consumes_turn then
    v_next := public.next_eligible_profile(
      'ringcentral'::public.rotation_kind,
      v_me.ringcentral_position
    );

    -- If no other eligible agent is found, wrap back to the same agent.
    if v_next is null then
      v_next := v_me.id;
    end if;

    update public.rotation_state
    set current_profile_id = v_next,
        version = version + 1,
        updated_at = now(),
        updated_by = v_me.id
    where kind::text = 'ringcentral';

    insert into public.turn_events (
      rotation,
      action,
      actor_profile_id,
      previous_profile_id,
      next_profile_id,
      work_item_id,
      reason
    )
    values (
      'ringcentral',
      'claim',
      v_me.id,
      v_me.id,
      v_next,
      v_work_item_id,
      case
        when v_was_already_claimed then 'Customer Service intake claim recovered and converted'
        when v_is_walk_in then 'Walk-in customer claimed during this agent''s RingCentral turn'
        else 'Customer Service intake claimed and converted'
      end
    );
  end if;

  return v_work_item_id;
end;
$$;

revoke all on function public.cs_intake_claim_ringcentral(uuid) from public;
grant execute on function public.cs_intake_claim_ringcentral(uuid) to authenticated;
grant execute on function public.cs_intake_claim_ringcentral(uuid) to service_role;

comment on function public.cs_intake_claim_ringcentral(uuid) is
  'Atomically claims a Customer Service intake, creates the canonical active Work Desk quote, and advances the RingCentral turn. Walk-in intakes may only be taken by agents with profiles.can_claim_walk_in, are served regardless of whose turn it is, and consume the RingCentral turn only when the claiming agent actually holds it.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- Post-conditions
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid)
    into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'cs_intake_claim_ringcentral';

  if v_def is null then
    raise exception 'v1.11.2 did not install cs_intake_claim_ringcentral'
      using hint = 'Rolling back.';
  end if;

  -- The walk-in authorization gate from v1.11.0 must survive this rewrite.
  if v_def not like '%can_claim_walk_in%' then
    raise exception 'v1.11.2 dropped the v1.11.0 walk-in authorization gate'
      using hint = 'Rolling back.';
  end if;

  -- The rotation write and the turn_events insert must both sit behind the
  -- consume flag. If either escapes it, an out-of-turn walk-in would move the
  -- queue, which is the exact thing this migration exists to prevent.
  if v_def not like '%if v_consumes_turn then%' then
    raise exception 'v1.11.2 has no v_consumes_turn branch guarding the rotation write'
      using hint = 'Rolling back.';
  end if;

  if (
    select count(*)
    from regexp_matches(v_def, 'update public\.rotation_state', 'g')
  ) <> 1 then
    raise exception 'v1.11.2 expects exactly one rotation_state write in cs_intake_claim_ringcentral'
      using hint = 'Rolling back.';
  end if;

  if (
    select count(*)
    from regexp_matches(v_def, 'insert into public\.turn_events', 'g')
  ) <> 1 then
    raise exception 'v1.11.2 expects exactly one turn_events insert in cs_intake_claim_ringcentral'
      using hint = 'Rolling back.';
  end if;

  -- Both of those statements must appear AFTER the guard, not before it.
  if position('if v_consumes_turn then' in v_def)
     > position('update public.rotation_state' in v_def) then
    raise exception 'v1.11.2 writes rotation_state before the v_consumes_turn guard'
      using hint = 'Rolling back.';
  end if;

  if position('if v_consumes_turn then' in v_def)
     > position('insert into public.turn_events' in v_def) then
    raise exception 'v1.11.2 writes turn_events before the v_consumes_turn guard'
      using hint = 'Rolling back.';
  end if;

  -- The idempotency return must still precede the walk-in gate.
  if position('return v_row.work_item_id' in v_def)
     > position('Only % can take walk-in intakes' in v_def) then
    raise exception 'v1.11.2 moved the walk-in gate ahead of the idempotency return'
      using hint = 'Rolling back.';
  end if;

  raise notice 'v1.11.2 applied. Walk-ins are served out of turn and consume the RingCentral turn only when the claimer holds it.';
end
$post$;

commit;
