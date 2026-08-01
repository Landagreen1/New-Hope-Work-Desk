-- New Hope Work Desk — v1.9.4 attendance mutation probe
--
-- Spec: .kiro/specs/time-attendance-ui-redesign
-- Requirements: 5.15, 5.16, 5.17, 11.8, 11.9, 12.12, 12.13, 12.15, 12.16, 16.1,
--               16.2, 16.6, 21.4, 21.7, 21.9, 21.10, 21.12
-- Companion to: supabase/migrations/v1.9.4-attendance-mutations.sql
--
-- WHAT THIS ANSWERS, AND WHY THE MIGRATION CANNOT ANSWER IT
--
-- The migration's own verification block reports structure: two functions exist, both
-- are security definer, the policy names waitlisted. None of that is behaviour. A
-- function that compiles is not a manager who was turned away, and an audit insert
-- placed last is not a change that was rolled back when it failed.
--
-- This script exercises the behaviour: it corrects real punches, replays a correction,
-- forces the audit insert to fail, marks the same day reviewed twice, and cancels a
-- waitlisted request as the employee who owns it.
--
-- HOW IT IMPERSONATES
--
-- `set local role authenticated` drops out of the table-owning role so the role test
-- inside each function is answered by a real caller, and `set local
-- request.jwt.claims` supplies the subject auth.uid() reads. Both functions are
-- `security definer`, so they still write what they are entitled to write; what
-- changes with the impersonation is only who they believe is calling.
--
-- SAFETY
--
-- Every statement runs inside a single transaction that ends in ROLLBACK — the
-- fixtures, the helper functions, the temporary trigger, and every row the two
-- functions write. Nothing is committed, so the counts in
-- supabase/verification/row-retention/stage-5-pre.json stay exact and Requirement 23,
-- criterion 3 is unaffected. Fixture instants are in 2099, so no real clock entry,
-- schedule, or payroll period is involved, and the subject profile is chosen as one
-- with no open clock entry so no live session is disturbed. Re-runnable any number of
-- times.
--
-- USAGE
--
--   node scripts/run-sql.mjs supabase/verification/v1.9.4-attendance-mutation-probe.sql
--
-- Every row of the report must read PASS.

begin;

-- ─────────────────────────────────────────────────────────────────────────────────
-- ACTORS
--
-- Drawn from live profiles rather than named, so the probe does not hard-code a
-- person. The manager is here because Requirement 21, criterion 12 withholds clock
-- correction from `manager`: a manager must be refused exactly as an employee is.
-- ─────────────────────────────────────────────────────────────────────────────────
create temporary table probe_actors on commit drop as
select (select p.id from public.profiles p
         where p.is_active and p.role = 'super_admin'
         order by p.created_at, p.id limit 1)                    as decider,
       (select p.id from public.profiles p
         where p.is_active and p.role not in ('super_admin', 'manager')
           and not exists (select 1 from public.time_clock_entries e
                            where e.profile_id = p.id and e.clock_out is null)
         order by p.created_at, p.id limit 1)                    as subject,
       (select p.id from public.profiles p
         where p.is_active and p.role = 'manager'
         order by p.created_at, p.id limit 1)                    as a_manager;

create temporary table probe_results (
  ord      integer,
  section  text,
  probe    text,
  observed text,
  expected text
) on commit drop;

-- Ids the sections share, so a later section can read what an earlier one wrote.
create temporary table probe_fixtures (
  closed_entry uuid,
  open_entry   uuid,
  break_row    uuid,
  waitlisted   uuid,
  pending      uuid,
  work_date    date
) on commit drop;

-- ─────────────────────────────────────────────────────────────────────────────────
-- CALLING THE TWO FUNCTIONS AS SOMEBODY
--
-- Created inside the transaction, so they roll back with everything else. Each
-- returns the function's envelope, or an envelope of its own describing the raise —
-- every guard rejection raises, and a raise that escaped would abort the probe rather
-- than be reported by it. The inner block is a subtransaction, so a rejected call
-- leaves nothing behind, which is what the "unchanged" assertions read.
--
-- A null actor is the unauthenticated case: the claims are set to an object carrying
-- no subject, which is what auth.uid() reads as null.
-- ─────────────────────────────────────────────────────────────────────────────────
create function public._probe_become(p_actor uuid) returns void language plpgsql as $probe$
begin
  execute 'set local role authenticated';
  execute format('set local request.jwt.claims = %L',
                 case when p_actor is null then '{}'
                      else json_build_object('sub', p_actor, 'role', 'authenticated')::text end);
end
$probe$;

create function public._probe_correct(
  p_actor uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_profile uuid,
  p_date date,
  p_field text,
  p_value jsonb,
  p_reason text default 'probe correction',
  p_key text default null
) returns jsonb language plpgsql as $probe$
declare
  v_out jsonb;
begin
  begin
    perform public._probe_become(p_actor);

    v_out := public.attendance_apply_correction(
      p_entity_type, p_entity_id, p_profile, p_date, p_field, p_value, p_reason,
      coalesce(p_key, 'probe-' || gen_random_uuid()::text));

    execute 'reset role';
  exception
    when others then
      -- The subtransaction is already undone; the role setting went with it.
      v_out := jsonb_build_object(
        'ok', false, 'applied', false, 'raised', true,
        'code', split_part(sqlerrm, ':', 1),
        'sqlstate', sqlstate, 'error', sqlerrm);
  end;
  return v_out;
end
$probe$;

create function public._probe_review(p_actor uuid, p_profile uuid, p_date date)
returns jsonb language plpgsql as $probe$
declare
  v_out jsonb;
begin
  begin
    perform public._probe_become(p_actor);
    v_out := public.attendance_mark_reviewed(p_profile, p_date);
    execute 'reset role';
  exception
    when others then
      v_out := jsonb_build_object(
        'ok', false, 'applied', false, 'raised', true,
        'code', split_part(sqlerrm, ':', 1),
        'sqlstate', sqlstate, 'error', sqlerrm);
  end;
  return v_out;
end
$probe$;

-- One statement as one caller, reporting the rows it touched or the refusal it met.
-- Used for the row level security section, where the answer is a row count rather
-- than an envelope.
create function public._probe_statement(p_actor uuid, p_sql text)
returns jsonb language plpgsql as $probe$
declare
  v_rows integer;
begin
  begin
    perform public._probe_become(p_actor);
    execute p_sql;
    get diagnostics v_rows = row_count;
    execute 'reset role';
    return jsonb_build_object('ok', true, 'rows', v_rows);
  exception
    when others then
      return jsonb_build_object('ok', false, 'rows', 0,
                                'sqlstate', sqlstate, 'error', sqlerrm);
  end;
end
$probe$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- FIXTURES
--
-- One closed session with a lunch break, one open session, one waitlisted and one
-- pending time-off request. All in 2099.
-- ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_subject uuid;
  v_date    date := date '2099-03-02';
  v_closed  uuid := gen_random_uuid();
  v_open    uuid := gen_random_uuid();
  v_break   uuid := gen_random_uuid();
  v_wait    uuid := gen_random_uuid();
  v_pending uuid := gen_random_uuid();
begin
  select subject into v_subject from probe_actors;

  if v_subject is null then
    raise exception 'probe needs an active non-administrator profile with no open clock entry';
  end if;

  if (select decider from probe_actors) is null then
    raise exception 'probe needs an active super_admin profile';
  end if;

  -- 13:00Z to 21:00Z, 30 unpaid minutes: 480 - 30 = 450 minutes = 7.5 hours.
  insert into public.time_clock_entries (id, profile_id, clock_in, clock_out, break_minutes, total_hours)
  values (v_closed, v_subject, timestamptz '2099-03-02 13:00:00+00', timestamptz '2099-03-02 21:00:00+00', 30, 7.50);

  insert into public.time_clock_breaks (id, clock_entry_id, break_start, break_end, break_type, duration_minutes)
  values (v_break, v_closed, timestamptz '2099-03-02 17:00:00+00', timestamptz '2099-03-02 17:30:00+00', 'lunch', 30);

  -- The missing clock-out of Requirement 5, criterion 15.
  insert into public.time_clock_entries (id, profile_id, clock_in, clock_out, break_minutes, total_hours)
  values (v_open, v_subject, timestamptz '2099-03-03 13:00:00+00', null, 0, null);

  insert into public.pto_requests (id, profile_id, pto_type, start_date, end_date, total_days, status)
  values (v_wait,    v_subject, 'vacation', date '2099-04-06', date '2099-04-10', 5.0, 'waitlisted'),
         (v_pending, v_subject, 'vacation', date '2099-05-04', date '2099-05-08', 5.0, 'pending');

  insert into probe_fixtures values (v_closed, v_open, v_break, v_wait, v_pending, v_date);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 1. WHO MAY CORRECT (Requirements 21.4, 21.10, 21.12)
-- ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_decider uuid;
  v_subject uuid;
  v_manager uuid;
  v_entry   uuid;
  v_date    date;
  v_out     jsonb;
begin
  select decider, subject, a_manager into v_decider, v_subject, v_manager from probe_actors;
  select closed_entry, work_date into v_entry, v_date from probe_fixtures;

  v_out := public._probe_correct(null, 'clock_entry', v_entry, v_subject, v_date,
             'clock_in', to_jsonb('2099-03-02 14:00:00+00'::text));
  insert into probe_results values
    (10, '1. who may correct', 'no signed-in caller', v_out->>'code', 'NOT_AUTHENTICATED');

  v_out := public._probe_correct(v_subject, 'clock_entry', v_entry, v_subject, v_date,
             'clock_in', to_jsonb('2099-03-02 14:00:00+00'::text));
  insert into probe_results values
    (11, '1. who may correct', 'the employee whose entry it is', v_out->>'code', 'NOT_AUTHORISED');

  if v_manager is not null then
    v_out := public._probe_correct(v_manager, 'clock_entry', v_entry, v_subject, v_date,
               'clock_in', to_jsonb('2099-03-02 14:00:00+00'::text));
    insert into probe_results values
      (12, '1. who may correct', 'a manager', v_out->>'code', 'NOT_AUTHORISED');

    v_out := public._probe_review(v_manager, v_subject, v_date);
    insert into probe_results values
      (13, '1. who may correct', 'a manager marking a day reviewed', v_out->>'code', 'NOT_AUTHORISED');
  end if;

  v_out := public._probe_review(v_subject, v_subject, v_date);
  insert into probe_results values
    (14, '1. who may correct', 'the employee marking their own day reviewed',
      v_out->>'code', 'NOT_AUTHORISED');

  insert into probe_results values
    (15, '1. who may correct', 'the entry after every refusal',
      (select format('%s|%s', e.clock_in, e.total_hours) from public.time_clock_entries e where e.id = v_entry),
      '2099-03-02 13:00:00+00|7.50'),
    (16, '1. who may correct', 'audit rows written by a refused call',
      (select count(*)::text from public.attendance_audit_log where profile_id = v_subject
        and work_date = v_date), '0'),
    (17, '1. who may correct', 'review rows written by a refused call',
      (select count(*)::text from public.attendance_day_reviews where profile_id = v_subject
        and work_date = v_date), '0');
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 2. WHAT A CORRECTION MUST CARRY (Requirements 5.16, 12.13, 21.9)
-- ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_decider uuid;
  v_subject uuid;
  v_entry   uuid;
  v_break   uuid;
  v_date    date;
  v_out     jsonb;
begin
  select decider, subject into v_decider, v_subject from probe_actors;
  select closed_entry, break_row, work_date into v_entry, v_break, v_date from probe_fixtures;

  v_out := public._probe_correct(v_decider, 'clock_entry', v_entry, v_subject, v_date,
             'clock_in', to_jsonb('2099-03-02 14:00:00+00'::text), '   ');
  insert into probe_results values
    (20, '2. what it must carry', 'a whitespace-only reason', v_out->>'code', 'REASON_REQUIRED');

  v_out := public._probe_correct(v_decider, 'clock_entry', v_entry, v_subject, v_date,
             'total_hours', to_jsonb(9));
  insert into probe_results values
    (21, '2. what it must carry', 'a field outside the vocabulary', v_out->>'code', 'UNKNOWN_FIELD');

  v_out := public._probe_correct(v_decider, 'break', v_entry, v_subject, v_date,
             'clock_in', to_jsonb('2099-03-02 14:00:00+00'::text));
  insert into probe_results values
    (22, '2. what it must carry', 'an entity type that disagrees with the field',
      v_out->>'code', 'ENTITY_TYPE_MISMATCH');

  v_out := public._probe_correct(v_decider, 'clock_entry', v_entry, v_subject, v_date,
             'clock_in', to_jsonb('not an instant'::text));
  insert into probe_results values
    (23, '2. what it must carry', 'a clock-in that is not an instant', v_out->>'code', 'INVALID_VALUE');

  -- A clock-in later than the clock-out would make the session negative.
  v_out := public._probe_correct(v_decider, 'clock_entry', v_entry, v_subject, v_date,
             'clock_in', to_jsonb('2099-03-02 22:00:00+00'::text));
  insert into probe_results values
    (24, '2. what it must carry', 'a clock-in later than the clock-out',
      v_out->>'code', 'NEGATIVE_DURATION');

  v_out := public._probe_correct(v_decider, 'break', v_break, v_subject, v_date,
             'duration_minutes', to_jsonb(2000));
  insert into probe_results values
    (25, '2. what it must carry', 'a break longer than a day', v_out->>'code', 'INVALID_VALUE');

  v_out := public._probe_correct(v_decider, 'note', null, v_subject, v_date,
             'note', to_jsonb('   '::text), null);
  insert into probe_results values
    (26, '2. what it must carry', 'a blank manager note', v_out->>'code', 'NOTE_REQUIRED');

  v_out := public._probe_correct(v_decider, 'clock_entry', v_entry, v_subject, v_date,
             'clock_in', to_jsonb('2099-03-02 14:00:00+00'::text), 'probe correction', '   ');
  insert into probe_results values
    (27, '2. what it must carry', 'a blank idempotency key',
      v_out->>'code', 'IDEMPOTENCY_KEY_REQUIRED');

  insert into probe_results values
    (28, '2. what it must carry', 'the entry after eight refusals',
      (select format('%s|%s', e.clock_in, e.total_hours) from public.time_clock_entries e where e.id = v_entry),
      '2099-03-02 13:00:00+00|7.50'),
    (29, '2. what it must carry', 'audit rows written by a refused call',
      (select count(*)::text from public.attendance_audit_log where profile_id = v_subject
        and work_date = v_date), '0');
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 3. THE CORRECTIONS THEMSELVES (Requirements 5.15, 5.17, 12.12, 16.1, 16.2)
-- ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_decider uuid;
  v_subject uuid;
  v_closed  uuid;
  v_open    uuid;
  v_break   uuid;
  v_date    date;
  v_out     jsonb;
  v_hours   numeric(6,2);
begin
  select decider, subject into v_decider, v_subject from probe_actors;
  select closed_entry, open_entry, break_row, work_date
    into v_closed, v_open, v_break, v_date from probe_fixtures;

  -- Add Missing Punch: the open session gets its clock-out. 13:00Z to 21:15Z, no
  -- break: 495 minutes = 8.25 hours by the inherited arithmetic.
  v_out := public._probe_correct(v_decider, 'clock_entry', v_open, v_subject, date '2099-03-03',
             'clock_out', to_jsonb('2099-03-03 21:15:00+00'::text), 'forgot to clock out');

  insert into probe_results values
    (30, '3. corrections', 'the clock-out was applied', v_out->>'applied', 'true'),
    (31, '3. corrections', 'giving an open entry its first clock-out is add_punch',
      v_out->>'action', 'add_punch'),
    (32, '3. corrections', 'total_hours recomputed by the inherited arithmetic',
      (select e.total_hours::text from public.time_clock_entries e where e.id = v_open), '8.25'),
    (33, '3. corrections', 'the correction is attributed to its author',
      (select (e.adjusted_by = v_decider)::text || '|' || e.adjustment_reason
         from public.time_clock_entries e where e.id = v_open),
      'true|forgot to clock out'),
    (34, '3. corrections', 'the audit row carries the previous value',
      (select a.old_value->>'clock_out' is null and a.new_value->>'clock_out' is not null
         from public.attendance_audit_log a where a.id = (v_out->>'audit_id')::uuid)::text,
      'true'),
    (35, '3. corrections', 'the audit row names the employee, the date, and the reason',
      (select format('%s|%s|%s', (a.profile_id = v_subject)::text, a.work_date, a.reason)
         from public.attendance_audit_log a where a.id = (v_out->>'audit_id')::uuid),
      format('true|%s|forgot to clock out', date '2099-03-03'));

  -- Correct Punch on a closed session: 13:30Z to 21:00Z less 30 = 420 minutes = 7.0.
  v_out := public._probe_correct(v_decider, 'clock_entry', v_closed, v_subject, v_date,
             'clock_in', to_jsonb('2099-03-02 13:30:00+00'::text), 'arrived late, badge failed');

  insert into probe_results values
    (36, '3. corrections', 'the clock-in was applied', v_out->>'applied', 'true'),
    (37, '3. corrections', 'correcting an existing punch is correct_punch',
      v_out->>'action', 'correct_punch'),
    (38, '3. corrections', 'total_hours followed the corrected clock-in',
      (select e.total_hours::text from public.time_clock_entries e where e.id = v_closed), '7.00');

  -- Break minutes, as the derivation reads them. The entry's own figures stay put.
  select total_hours into v_hours from public.time_clock_entries where id = v_closed;

  v_out := public._probe_correct(v_decider, 'break', v_break, v_subject, v_date,
             'duration_minutes', to_jsonb(45), 'lunch ran over');

  insert into probe_results values
    (39, '3. corrections', 'the break minutes were applied',
      (select b.duration_minutes::text from public.time_clock_breaks b where b.id = v_break), '45'),
    (40, '3. corrections', 'the break bounds were left alone',
      (select format('%s|%s', b.break_start, b.break_end)
         from public.time_clock_breaks b where b.id = v_break),
      '2099-03-02 17:00:00+00|2099-03-02 17:30:00+00'),
    (41, '3. corrections', 'the entry''s own total_hours was not touched',
      (select e.total_hours::text from public.time_clock_entries e where e.id = v_closed),
      v_hours::text);

  -- A corrected break bound re-derives the stored duration, so the stale figure cannot
  -- win in the derivation.
  v_out := public._probe_correct(v_decider, 'break', v_break, v_subject, v_date,
             'break_end', to_jsonb('2099-03-02 18:00:00+00'::text), 'break ended later');

  insert into probe_results values
    (42, '3. corrections', 'a corrected break end re-derives duration_minutes',
      (select b.duration_minutes::text from public.time_clock_breaks b where b.id = v_break), '60');

  -- Add Missing Punch where no session exists at all.
  v_out := public._probe_correct(v_decider, 'clock_entry', null, v_subject, date '2099-03-04',
             'session', jsonb_build_object(
               'clock_in', '2099-03-04 13:00:00+00',
               'clock_out', '2099-03-04 20:00:00+00',
               'break_minutes', 60),
             'worked, never clocked in');

  insert into probe_results values
    (43, '3. corrections', 'the added session exists', v_out->>'applied', 'true'),
    (44, '3. corrections', 'the added session carries its computed hours',
      (select e.total_hours::text from public.time_clock_entries e
        where e.id = (v_out->'new_value'->>'clock_entry_id')::uuid), '6.00'),
    (45, '3. corrections', 'adding a session is add_punch', v_out->>'action', 'add_punch');

  -- A manager note. Its own text stands in for the reason.
  v_out := public._probe_correct(v_decider, 'note', null, v_subject, v_date,
             'note', to_jsonb('Spoke with employee about the badge reader.'::text), null);

  insert into probe_results values
    (46, '3. corrections', 'the note was recorded',
      (select n.note from public.attendance_notes n
        where n.id = (v_out->'new_value'->>'note_id')::uuid),
      'Spoke with employee about the badge reader.'),
    (47, '3. corrections', 'the note is its own stated reason',
      v_out->>'reason', 'Spoke with employee about the badge reader.'),
    (48, '3. corrections', 'the note is attributed to its author',
      (select (n.author_profile_id = v_decider)::text from public.attendance_notes n
        where n.id = (v_out->'new_value'->>'note_id')::uuid), 'true');

  -- Approving unscheduled work is the audit row and nothing else.
  v_out := public._probe_correct(v_decider, 'clock_entry', v_closed, v_subject, v_date,
             'unscheduled_work', 'true'::jsonb, 'covered a colleague at my request');

  insert into probe_results values
    (49, '3. corrections', 'the approval is recorded as approve_unscheduled',
      v_out->>'action', 'approve_unscheduled'),
    (50, '3. corrections', 'attendance-service can read it by action and date',
      (select count(*)::text from public.attendance_audit_log a
        where a.action = 'approve_unscheduled' and a.profile_id = v_subject
          and a.work_date = v_date), '1'),
    (51, '3. corrections', 'refusing to un-approve it',
      (public._probe_correct(v_decider, 'clock_entry', v_closed, v_subject, v_date,
         'unscheduled_work', 'false'::jsonb))->>'code', 'INVALID_VALUE');

  -- Every applied correction wrote exactly one audit row.
  insert into probe_results values
    (52, '3. corrections', 'audit rows for the seven applied corrections',
      (select count(*)::text from public.attendance_audit_log a
        where a.actor_profile_id = v_decider and a.profile_id = v_subject
          and a.work_date between date '2099-03-02' and date '2099-03-04'), '7'),
    (53, '3. corrections', 'no audit row could be rewritten',
      (select (public._probe_statement(v_decider,
                 format('update public.attendance_audit_log set reason = ''tampered'' where id = %L',
                        (v_out->>'audit_id')::uuid)))->>'ok'), 'false');
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 4. A REPLAYED CORRECTION (task 14.2: prior result, applied false, second entry)
-- ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_decider uuid;
  v_subject uuid;
  v_closed  uuid;
  v_date    date;
  v_key     text := 'probe-replay-key';
  v_first   jsonb;
  v_second  jsonb;
begin
  select decider, subject into v_decider, v_subject from probe_actors;
  select closed_entry, work_date into v_closed, v_date from probe_fixtures;

  v_first := public._probe_correct(v_decider, 'clock_entry', v_closed, v_subject, v_date,
               'break_minutes', to_jsonb(45), 'lunch ran over', v_key);

  -- The same key, a different value. The value must not land.
  v_second := public._probe_correct(v_decider, 'clock_entry', v_closed, v_subject, v_date,
                'break_minutes', to_jsonb(90), 'lunch ran over', v_key);

  insert into probe_results values
    (60, '4. replay', 'the first call applied', v_first->>'applied', 'true'),
    (61, '4. replay', 'the second call applied nothing', v_second->>'applied', 'false'),
    (62, '4. replay', 'the second call named the outcome', v_second->>'code', 'already_applied'),
    (63, '4. replay', 'the second call returned the first result',
      v_second->>'audit_id', v_first->>'audit_id'),
    (64, '4. replay', 'the entry keeps the first value, not the replayed one',
      (select e.break_minutes::text from public.time_clock_entries e where e.id = v_closed), '45'),
    (65, '4. replay', 'the replay is recorded as a second audit row',
      (select count(*)::text from public.attendance_audit_log a
        where a.profile_id = v_subject and a.work_date = v_date
          and a.new_value->>'idempotency_key' = v_key), '2'),
    (66, '4. replay', 'the second row points at the first',
      (select (a.new_value->>'replay_of')::uuid::text from public.attendance_audit_log a
        where a.id = (v_second->>'replay_audit_id')::uuid),
      v_first->>'audit_id');
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 5. A FAILED AUDIT WRITE ROLLS THE CHANGE BACK (Requirement 16, criterion 6)
--
-- The trigger below refuses every insert into attendance_audit_log, which is the only
-- way to make the last statement of the function fail on demand. It is created and
-- dropped inside this transaction and never exists outside it.
-- ─────────────────────────────────────────────────────────────────────────────────
create function public._probe_refuse_audit() returns trigger language plpgsql as $probe$
begin
  raise exception 'PROBE_AUDIT_FAILURE: refusing this audit insert on purpose'
    using errcode = 'P0001';
end
$probe$;

create trigger _probe_refuse_audit
  before insert on public.attendance_audit_log
  for each row execute function public._probe_refuse_audit();

do $$
declare
  v_decider uuid;
  v_subject uuid;
  v_closed  uuid;
  v_date    date;
  v_before  text;
  v_out     jsonb;
begin
  select decider, subject into v_decider, v_subject from probe_actors;
  select closed_entry, work_date into v_closed, v_date from probe_fixtures;

  select format('%s|%s|%s', e.clock_in, e.break_minutes, e.total_hours) into v_before
    from public.time_clock_entries e where e.id = v_closed;

  v_out := public._probe_correct(v_decider, 'clock_entry', v_closed, v_subject, v_date,
             'clock_in', to_jsonb('2099-03-02 15:00:00+00'::text), 'this must not land');

  insert into probe_results values
    (70, '5. audit failure', 'the call was not honoured', v_out->>'ok', 'false'),
    (71, '5. audit failure', 'the failure names the audit write', v_out->>'code', 'audit_write_failed'),
    (72, '5. audit failure', 'the failure states the reason',
      (v_out->>'error' like '%PROBE_AUDIT_FAILURE%')::text, 'true'),
    (73, '5. audit failure', 'the change was rolled back with it',
      (select format('%s|%s|%s', e.clock_in, e.break_minutes, e.total_hours)
         from public.time_clock_entries e where e.id = v_closed), v_before);

  -- The same for marking a day reviewed: no review row survives a failed audit write.
  v_out := public._probe_review(v_decider, v_subject, date '2099-03-05');

  insert into probe_results values
    (74, '5. audit failure', 'a review with a failed audit write was not honoured',
      v_out->>'ok', 'false'),
    (75, '5. audit failure', 'the review row was rolled back with it',
      (select count(*)::text from public.attendance_day_reviews r
        where r.profile_id = v_subject and r.work_date = date '2099-03-05'), '0');
end;
$$;

drop trigger _probe_refuse_audit on public.attendance_audit_log;
drop function public._probe_refuse_audit();

-- ─────────────────────────────────────────────────────────────────────────────────
-- 6. MARKING A DAY REVIEWED (Requirements 12.15, 12.16)
-- ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_decider uuid;
  v_subject uuid;
  v_date    date;
  v_first   jsonb;
  v_second  jsonb;
begin
  select decider, subject into v_decider, v_subject from probe_actors;
  select work_date into v_date from probe_fixtures;

  v_first  := public._probe_review(v_decider, v_subject, v_date);
  v_second := public._probe_review(v_decider, v_subject, v_date);

  insert into probe_results values
    (80, '6. review', 'the first review applied', v_first->>'applied', 'true'),
    (81, '6. review', 'it recorded the actor',
      (v_first->>'reviewed_by')::uuid::text, v_decider::text),
    (82, '6. review', 'it recorded the timestamp',
      (v_first->>'reviewed_at' is not null)::text, 'true'),
    (83, '6. review', 'it wrote one audit row',
      (select count(*)::text from public.attendance_audit_log a
        where a.action = 'mark_reviewed' and a.profile_id = v_subject and a.work_date = v_date), '1'),
    (84, '6. review', 'the second review applied nothing', v_second->>'applied', 'false'),
    (85, '6. review', 'the second review named the outcome', v_second->>'code', 'already_reviewed'),
    (86, '6. review', 'the first reviewer and timestamp were retained',
      format('%s|%s', v_second->>'reviewed_by', v_second->>'reviewed_at'),
      format('%s|%s', v_first->>'reviewed_by', v_first->>'reviewed_at')),
    (87, '6. review', 'the repeat wrote no second audit row',
      (select count(*)::text from public.attendance_audit_log a
        where a.action = 'mark_reviewed' and a.profile_id = v_subject and a.work_date = v_date), '1'),
    (88, '6. review', 'one review row for the employee-date',
      (select count(*)::text from public.attendance_day_reviews r
        where r.profile_id = v_subject and r.work_date = v_date), '1');
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- 7. THE WIDENED PTO_REQUESTS_UPDATE POLICY
--    (Requirements 11.8, 11.9, 21.7, 21.10)
-- ─────────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_subject uuid;
  v_wait    uuid;
  v_pending uuid;
  v_out     jsonb;
begin
  select subject into v_subject from probe_actors;
  select waitlisted, pending into v_wait, v_pending from probe_fixtures;

  -- What was refused before this migration: cancelling a waitlisted request.
  v_out := public._probe_statement(v_subject,
             format('update public.pto_requests set status = ''cancelled'' where id = %L', v_wait));
  insert into probe_results values
    (90, '7. pto policy', 'an employee cancels their waitlisted request',
      format('%s|%s', v_out->>'ok', v_out->>'rows'), 'true|1'),
    (91, '7. pto policy', 'the status moved',
      (select r.status from public.pto_requests r where r.id = v_wait), 'cancelled');

  -- Still permitted: cancelling a pending request.
  v_out := public._probe_statement(v_subject,
             format('update public.pto_requests set status = ''cancelled'' where id = %L', v_pending));
  insert into probe_results values
    (92, '7. pto policy', 'an employee cancels their pending request',
      format('%s|%s', v_out->>'ok', v_out->>'rows'), 'true|1');

  -- Never permitted: deciding your own request. Requirement 21, criteria 7 and 10.
  update public.pto_requests set status = 'pending' where id = v_pending;

  v_out := public._probe_statement(v_subject,
             format('update public.pto_requests set status = ''approved'' where id = %L', v_pending));
  insert into probe_results values
    (93, '7. pto policy', 'an employee approving their own request',
      format('%s|%s', v_out->>'ok', v_out->>'rows'), 'false|0'),
    (94, '7. pto policy', 'row level security is what refused it',
      (v_out->>'sqlstate'), '42501'),
    (95, '7. pto policy', 'the request did not move',
      (select r.status from public.pto_requests r where r.id = v_pending), 'pending');

  -- A decided request stays out of reach. Requirement 11, criterion 10.
  update public.pto_requests set status = 'approved' where id = v_pending;

  v_out := public._probe_statement(v_subject,
             format('update public.pto_requests set status = ''cancelled'' where id = %L', v_pending));
  insert into probe_results values
    (96, '7. pto policy', 'an employee cancelling an approved request',
      format('%s|%s', v_out->>'ok', v_out->>'rows'), 'true|0');
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────
-- REPORT
-- ─────────────────────────────────────────────────────────────────────────────────
select section,
       probe,
       observed,
       expected,
       case when observed is not distinct from expected then 'PASS' else 'FAIL' end as verdict
  from probe_results
 order by ord;

rollback;
