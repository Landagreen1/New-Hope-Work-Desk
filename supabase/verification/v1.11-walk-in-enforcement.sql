-- End-to-end proof of the walk-in rules (v1.11.0 + v1.11.2) against the live database.
--
-- Creates throwaway intakes, drives every claim path through them, and rolls the
-- whole thing back. Nothing survives this file. Any FAIL raises; the rollback
-- happens either way.
--
-- RULES UNDER TEST
--   v1.11.0  Only profiles with can_claim_walk_in may take a walk-in intake.
--   v1.11.2  An authorized walk-in agent takes the walk-in regardless of whose
--            turn it is. The RingCentral turn is consumed ONLY when that agent
--            actually holds it. Out of turn, the queue order must not change at
--            all: same current_profile_id, same version, no turn_events row.
--
-- COVERAGE
--   1  cs_intake_claim              — unauthorized refused, authorized allowed
--   2  cs_intake_claim_ringcentral  — unauthorized refused even holding the turn
--   3  cs_intake_manager_assign     — unauthorized target refused, authorized ok
--   4  non-walk-in intakes unaffected by the gate
--   5  walk-in OUT of turn          — allowed, queue provably untouched
--   6  walk-in out of turn, retried — idempotent, still no queue change
--   7  walk-in ON turn              — allowed, queue advances exactly once
--   8  walk-in out of turn with ringcentral_active = false — still allowed
--   9  non-walk-in out of turn      — still refused (regression guard)
--  10  walk-in while unavailable    — refused

begin;

do $$
declare
  v_juliana   uuid;
  v_outsider  uuid;
  v_manager   uuid;
  v_creator   uuid;
  v_intake    uuid;
  v_plain     uuid;
  v_wi        uuid;
  v_wi2       uuid;
  v_rot_before     uuid;
  v_rot_ver_before bigint;
  v_rot_after      uuid;
  v_rot_ver_after  bigint;
  v_turn_before    bigint;
  v_turn_after     bigint;
  v_msg       text;
  v_detail    jsonb;
begin
  select id into v_juliana  from public.profiles where username = 'julianaa';
  select id into v_outsider from public.profiles where username = 'pablo';
  select id into v_manager  from public.profiles where username = 'danielp';
  select id into v_creator  from public.profiles where username = 'johnp';

  if v_juliana is null or v_outsider is null or v_manager is null or v_creator is null then
    raise exception 'SETUP FAIL: expected usernames julianaa, pablo, danielp, johnp to exist';
  end if;
  if not public.profile_can_claim_walk_in(v_juliana) then
    raise exception 'SETUP FAIL: Juliana is not walk-in eligible';
  end if;
  if public.profile_can_claim_walk_in(v_outsider) then
    raise exception 'SETUP FAIL: the control agent is walk-in eligible';
  end if;

  -- Both agents fully clocked in, so eligibility is never the reason a claim
  -- succeeds or fails except where a test changes it on purpose.
  update public.profiles
  set availability = 'available', ringcentral_active = true, is_active = true
  where id in (v_juliana, v_outsider);

  -- ════════════════════════════════════════════════════════════════════════
  -- 1. cs_intake_claim (general, non-RingCentral path)
  -- ════════════════════════════════════════════════════════════════════════
  insert into public.cs_intake_submissions (
    status, line_of_business, created_by, is_walk_in, intake_channel,
    insured_first_name, insured_last_name, submitted_at
  )
  values ('submitted', 'auto', v_creator, true, 'manual', 'WalkIn', 'Fixture', now())
  returning id into v_intake;

  insert into public.cs_intake_submissions (
    status, line_of_business, created_by, is_walk_in, intake_channel,
    insured_first_name, insured_last_name, submitted_at
  )
  values ('submitted', 'auto', v_creator, false, 'manual', 'Normal', 'Fixture', now())
  returning id into v_plain;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
  begin
    perform public.cs_intake_claim(v_intake);
    raise exception 'FAIL 1a: an unauthorized agent claimed a walk-in intake';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL 1a%' then raise; end if;
    if v_msg not like '%walk-in%' then
      raise exception 'FAIL 1a: refused for the wrong reason: %', v_msg;
    end if;
  end;
  if (select status::text from public.cs_intake_submissions where id = v_intake) <> 'submitted'
     or (select claimed_by from public.cs_intake_submissions where id = v_intake) is not null then
    raise exception 'FAIL 1a: the refused claim still wrote to the intake';
  end if;
  raise notice 'PASS 1a: cs_intake_claim refuses an unauthorized agent and writes nothing';

  -- 4. Same agent, non-walk-in intake: must still work.
  perform public.cs_intake_claim(v_plain);
  if (select claimed_by from public.cs_intake_submissions where id = v_plain) <> v_outsider then
    raise exception 'FAIL 4: the gate broke normal (non-walk-in) claiming';
  end if;
  raise notice 'PASS 4: non-walk-in intakes are unaffected';

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_juliana, 'role', 'authenticated')::text, true);
  perform public.cs_intake_claim(v_intake);
  if (select claimed_by from public.cs_intake_submissions where id = v_intake) <> v_juliana then
    raise exception 'FAIL 1b: the authorized walk-in agent could not claim';
  end if;
  raise notice 'PASS 1b: cs_intake_claim allows the authorized walk-in agent';

  -- ════════════════════════════════════════════════════════════════════════
  -- 2. Unauthorized agent HOLDING the turn is still refused, and the rotation
  --    must not move.
  -- ════════════════════════════════════════════════════════════════════════
  update public.cs_intake_submissions
  set status = 'submitted', claimed_by = null, claimed_at = null,
      intake_channel = 'ringcentral'
  where id = v_intake;

  update public.rotation_state
  set current_profile_id = v_outsider
  where kind = 'ringcentral'::public.rotation_kind;

  select current_profile_id, version into v_rot_before, v_rot_ver_before
    from public.rotation_state where kind = 'ringcentral'::public.rotation_kind;
  select count(*) into v_turn_before from public.turn_events;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_outsider, 'role', 'authenticated')::text, true);
  begin
    perform public.cs_intake_claim_ringcentral(v_intake);
    raise exception 'FAIL 2: an unauthorized turn holder claimed a walk-in intake';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL 2%' then raise; end if;
    if v_msg not like '%walk-in%' then
      raise exception 'FAIL 2: refused for the wrong reason: %', v_msg;
    end if;
  end;

  select current_profile_id, version into v_rot_after, v_rot_ver_after
    from public.rotation_state where kind = 'ringcentral'::public.rotation_kind;
  select count(*) into v_turn_after from public.turn_events;

  if v_rot_after is distinct from v_rot_before or v_rot_ver_after <> v_rot_ver_before then
    raise exception 'FAIL 2: the refused walk-in claim moved the turn (%/v% -> %/v%)',
                    v_rot_before, v_rot_ver_before, v_rot_after, v_rot_ver_after;
  end if;
  if v_turn_after <> v_turn_before then
    raise exception 'FAIL 2: the refused claim recorded % turn event(s)', v_turn_after - v_turn_before;
  end if;
  if (select status::text from public.cs_intake_submissions where id = v_intake) <> 'submitted' then
    raise exception 'FAIL 2: the refused claim changed the intake status';
  end if;
  raise notice 'PASS 2: an unauthorized turn holder is refused and the queue stays at %/v%',
               v_rot_before, v_rot_ver_before;

  -- ════════════════════════════════════════════════════════════════════════
  -- 3. cs_intake_manager_assign
  -- ════════════════════════════════════════════════════════════════════════
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_manager, 'role', 'authenticated')::text, true);
  begin
    perform public.cs_intake_manager_assign(v_intake, v_outsider);
    raise exception 'FAIL 3a: a manager routed a walk-in to an unauthorized agent';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL 3a%' then raise; end if;
    if v_msg not like '%walk-in%' then
      raise exception 'FAIL 3a: refused for the wrong reason: %', v_msg;
    end if;
  end;
  raise notice 'PASS 3a: cs_intake_manager_assign refuses an unauthorized target';

  perform public.cs_intake_manager_assign(v_intake, v_juliana);
  if (select claimed_by from public.cs_intake_submissions where id = v_intake) <> v_juliana
     or (select intake_channel from public.cs_intake_submissions where id = v_intake) <> 'manual' then
    raise exception 'FAIL 3b: the manager could not assign the walk-in to an authorized agent';
  end if;
  select current_profile_id, version into v_rot_after, v_rot_ver_after
    from public.rotation_state where kind = 'ringcentral'::public.rotation_kind;
  if v_rot_after is distinct from v_rot_before or v_rot_ver_after <> v_rot_ver_before then
    raise exception 'FAIL 3b: manager assignment consumed a RingCentral turn';
  end if;
  raise notice 'PASS 3b: cs_intake_manager_assign allows an authorized target and consumes no turn';

  -- ════════════════════════════════════════════════════════════════════════
  -- 5. v1.11.2 — walk-in taken OUT OF TURN. Allowed, queue untouched.
  -- ════════════════════════════════════════════════════════════════════════
  insert into public.cs_intake_submissions (
    status, line_of_business, created_by, is_walk_in, intake_channel,
    insured_first_name, insured_last_name, submitted_at
  )
  values ('submitted', 'auto', v_creator, true, 'ringcentral', 'OutOfTurn', 'Walkin', now())
  returning id into v_intake;

  -- The turn belongs to somebody else entirely.
  update public.rotation_state
  set current_profile_id = v_outsider
  where kind = 'ringcentral'::public.rotation_kind;

  select current_profile_id, version into v_rot_before, v_rot_ver_before
    from public.rotation_state where kind = 'ringcentral'::public.rotation_kind;
  select count(*) into v_turn_before from public.turn_events;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_juliana, 'role', 'authenticated')::text, true);
  v_wi := public.cs_intake_claim_ringcentral(v_intake);

  if v_wi is null then
    raise exception 'FAIL 5: the out-of-turn walk-in claim returned no work item';
  end if;
  if (select status::text from public.cs_intake_submissions where id = v_intake) <> 'converted' then
    raise exception 'FAIL 5: the out-of-turn walk-in was not converted';
  end if;
  if (select assigned_profile_id from public.work_items where id = v_wi) <> v_juliana then
    raise exception 'FAIL 5: the quote was not assigned to the claiming walk-in agent';
  end if;
  if (select assignment_method::text from public.work_items where id = v_wi) <> 'ringcentral_turn' then
    raise exception 'FAIL 5: assignment_method is %, expected ringcentral_turn so the agent still gets quote credit',
                    (select assignment_method::text from public.work_items where id = v_wi);
  end if;

  select current_profile_id, version into v_rot_after, v_rot_ver_after
    from public.rotation_state where kind = 'ringcentral'::public.rotation_kind;
  select count(*) into v_turn_after from public.turn_events;

  if v_rot_after is distinct from v_rot_before then
    raise exception 'FAIL 5: the out-of-turn walk-in changed the turn holder (% -> %)',
                    v_rot_before, v_rot_after;
  end if;
  if v_rot_ver_after <> v_rot_ver_before then
    raise exception 'FAIL 5: the out-of-turn walk-in bumped rotation_state.version (v% -> v%)',
                    v_rot_ver_before, v_rot_ver_after;
  end if;
  if v_turn_after <> v_turn_before then
    raise exception 'FAIL 5: the out-of-turn walk-in wrote % turn_events row(s)',
                    v_turn_after - v_turn_before;
  end if;

  -- The audit trail must say, explicitly, that no turn was consumed.
  select detail into v_detail
    from public.cs_intake_events
   where submission_id = v_intake
     and event_type = 'walk_in_claimed_out_of_turn';
  if v_detail is null then
    raise exception 'FAIL 5: no walk_in_claimed_out_of_turn intake event was recorded';
  end if;
  if (v_detail->>'consumed_turn')::boolean is not false then
    raise exception 'FAIL 5: the intake event does not record consumed_turn = false (%)', v_detail;
  end if;
  if (v_detail->>'held_turn')::boolean is not false then
    raise exception 'FAIL 5: the intake event does not record held_turn = false (%)', v_detail;
  end if;
  if not exists (
    select 1 from public.work_item_events
     where source_work_item_id = v_wi
       and event_type = 'walk_in_intake_claim_out_of_turn'
       and (details->>'consumed_turn')::boolean is false
  ) then
    raise exception 'FAIL 5: no walk_in_intake_claim_out_of_turn work item event with consumed_turn = false';
  end if;
  raise notice 'PASS 5: walk-in taken out of turn. Queue held at %/v% with no turn event.',
               v_rot_before, v_rot_ver_before;

  -- ════════════════════════════════════════════════════════════════════════
  -- 6. Retry of that same out-of-turn claim must be idempotent.
  -- ════════════════════════════════════════════════════════════════════════
  if public.cs_intake_claim_ringcentral(v_intake) <> v_wi then
    raise exception 'FAIL 6: the retry returned a different work item';
  end if;
  select current_profile_id, version into v_rot_after, v_rot_ver_after
    from public.rotation_state where kind = 'ringcentral'::public.rotation_kind;
  select count(*) into v_turn_after from public.turn_events;
  if v_rot_after is distinct from v_rot_before
     or v_rot_ver_after <> v_rot_ver_before
     or v_turn_after <> v_turn_before then
    raise exception 'FAIL 6: the retry disturbed the queue';
  end if;
  if (select count(*) from public.work_items where id = v_wi) <> 1 then
    raise exception 'FAIL 6: the retry duplicated the quote';
  end if;
  raise notice 'PASS 6: retrying an out-of-turn walk-in is idempotent';

  -- ════════════════════════════════════════════════════════════════════════
  -- 7. Walk-in ON the agent's own turn must consume it, exactly once.
  -- ════════════════════════════════════════════════════════════════════════
  insert into public.cs_intake_submissions (
    status, line_of_business, created_by, is_walk_in, intake_channel,
    insured_first_name, insured_last_name, submitted_at
  )
  values ('submitted', 'auto', v_creator, true, 'ringcentral', 'OnTurn', 'Walkin', now())
  returning id into v_intake;

  update public.rotation_state
  set current_profile_id = v_juliana
  where kind = 'ringcentral'::public.rotation_kind;

  select current_profile_id, version into v_rot_before, v_rot_ver_before
    from public.rotation_state where kind = 'ringcentral'::public.rotation_kind;
  select count(*) into v_turn_before from public.turn_events;

  v_wi2 := public.cs_intake_claim_ringcentral(v_intake);

  select current_profile_id, version into v_rot_after, v_rot_ver_after
    from public.rotation_state where kind = 'ringcentral'::public.rotation_kind;
  select count(*) into v_turn_after from public.turn_events;

  if v_rot_ver_after <> v_rot_ver_before + 1 then
    raise exception 'FAIL 7: expected exactly one version bump (v% -> v%)',
                    v_rot_ver_before, v_rot_ver_after;
  end if;
  if v_turn_after <> v_turn_before + 1 then
    raise exception 'FAIL 7: expected exactly one turn_events row, got %',
                    v_turn_after - v_turn_before;
  end if;
  if not exists (
    select 1 from public.turn_events
     where work_item_id = v_wi2
       and rotation = 'ringcentral'::public.rotation_kind
       and action = 'claim'
       and actor_profile_id = v_juliana
       and previous_profile_id = v_juliana
  ) then
    raise exception 'FAIL 7: the turn event for the on-turn walk-in is missing or malformed';
  end if;
  if not exists (
    select 1 from public.cs_intake_events
     where submission_id = v_intake
       and event_type = 'walk_in_claimed_on_turn'
       and (detail->>'consumed_turn')::boolean is true
  ) then
    raise exception 'FAIL 7: no walk_in_claimed_on_turn event with consumed_turn = true';
  end if;
  raise notice 'PASS 7: walk-in on the agent''s own turn consumed it once (% -> %, v% -> v%)',
               v_rot_before, v_rot_after, v_rot_ver_before, v_rot_ver_after;

  -- ════════════════════════════════════════════════════════════════════════
  -- 8. Out of turn with ringcentral_active = false is still allowed, because an
  --    out-of-turn walk-in does not use the rotation.
  -- ════════════════════════════════════════════════════════════════════════
  insert into public.cs_intake_submissions (
    status, line_of_business, created_by, is_walk_in, intake_channel,
    insured_first_name, insured_last_name, submitted_at
  )
  values ('submitted', 'auto', v_creator, true, 'ringcentral', 'RcOff', 'Walkin', now())
  returning id into v_intake;

  update public.profiles set ringcentral_active = false where id = v_juliana;
  update public.rotation_state
  set current_profile_id = v_outsider
  where kind = 'ringcentral'::public.rotation_kind;

  select version into v_rot_ver_before
    from public.rotation_state where kind = 'ringcentral'::public.rotation_kind;
  select count(*) into v_turn_before from public.turn_events;

  if public.cs_intake_claim_ringcentral(v_intake) is null then
    raise exception 'FAIL 8: a walk-in agent with RingCentral switched off could not take a walk-in';
  end if;

  select version into v_rot_ver_after
    from public.rotation_state where kind = 'ringcentral'::public.rotation_kind;
  select count(*) into v_turn_after from public.turn_events;
  if v_rot_ver_after <> v_rot_ver_before or v_turn_after <> v_turn_before then
    raise exception 'FAIL 8: that claim disturbed the queue';
  end if;
  update public.profiles set ringcentral_active = true where id = v_juliana;
  raise notice 'PASS 8: RingCentral membership is not required for an out-of-turn walk-in';

  -- ════════════════════════════════════════════════════════════════════════
  -- 9. Regression guard: a NON-walk-in intake still requires the turn.
  -- ════════════════════════════════════════════════════════════════════════
  insert into public.cs_intake_submissions (
    status, line_of_business, created_by, is_walk_in, intake_channel,
    insured_first_name, insured_last_name, submitted_at
  )
  values ('submitted', 'auto', v_creator, false, 'ringcentral', 'Normal', 'OutOfTurn', now())
  returning id into v_intake;

  update public.rotation_state
  set current_profile_id = v_outsider
  where kind = 'ringcentral'::public.rotation_kind;
  select count(*) into v_turn_before from public.turn_events;

  begin
    perform public.cs_intake_claim_ringcentral(v_intake);
    raise exception 'FAIL 9: a non-walk-in intake was claimed out of turn';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL 9%' then raise; end if;
    if v_msg not like '%belongs to another agent%' then
      raise exception 'FAIL 9: refused for the wrong reason: %', v_msg;
    end if;
  end;
  select count(*) into v_turn_after from public.turn_events;
  if v_turn_after <> v_turn_before then
    raise exception 'FAIL 9: the refused normal claim wrote a turn event';
  end if;
  raise notice 'PASS 9: non-walk-in intakes still require the current turn';

  -- ════════════════════════════════════════════════════════════════════════
  -- 10. A walk-in agent who is not Available cannot take a walk-in.
  -- ════════════════════════════════════════════════════════════════════════
  insert into public.cs_intake_submissions (
    status, line_of_business, created_by, is_walk_in, intake_channel,
    insured_first_name, insured_last_name, submitted_at
  )
  values ('submitted', 'auto', v_creator, true, 'ringcentral', 'Away', 'Walkin', now())
  returning id into v_intake;

  update public.profiles set availability = 'unavailable' where id = v_juliana;
  begin
    perform public.cs_intake_claim_ringcentral(v_intake);
    raise exception 'FAIL 10: an unavailable agent took a walk-in';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL 10%' then raise; end if;
    if v_msg not like '%Available%' then
      raise exception 'FAIL 10: refused for the wrong reason: %', v_msg;
    end if;
  end;
  raise notice 'PASS 10: an unavailable walk-in agent is refused';

  raise notice 'ALL WALK-IN CHECKS PASSED';
end
$$;

rollback;
