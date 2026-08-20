-- v1.19.3 verification probe — does a clock-out actually complete now?
--
-- Calls public.attendance_clock_out() as a real agent whose profile is in
-- `attendance_assisted` mode, so the queue transition arm runs too, then throws the
-- work away.
--
-- How the rollback works: the call, the re-reads and the retry all happen inside one
-- PL/pgSQL `begin ... exception` block, which is a subtransaction. Raising a private
-- errcode at the end of it and catching that errcode unwinds every database write it
-- made. PL/pgSQL variables are not transactional, so the observations captured into
-- variables survive the unwind and are written out afterwards.
--
-- Run: node scripts/run-sql.mjs supabase/verification/v1.19.3-clock-out-probe.sql

drop table if exists public._probe_1193;
create unlogged table public._probe_1193 (n int, what text, observed text);

do $probe$
declare
  v_subject  uuid := '4824a5fd-0487-4be7-bee8-1bfd02d12e47';  -- agent, attendance_assisted
  v_entry    uuid := '3f83ee17-05c4-4a0e-b683-af4c81f334e7';  -- their open entry
  v_before   text;
  v_raised   text := 'nothing';
  v_after    text := '(not reached)';
  v_queue    text := '(not reached)';
  v_status   text := '(not reached)';
  v_applied  text := '(not reached)';
  v_retry    text := '(not reached)';
  v_result   jsonb;
begin
  select format('%s|%s|%s', clock_out, clock_status, total_hours) into v_before
    from public.time_clock_entries where id = v_entry;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_subject::text, 'role', 'authenticated')::text,
                     true);

  begin
    v_result := public.attendance_clock_out();

    select format('closed=%s clock_status=%s total_hours=%s',
                  clock_out is not null, clock_status, total_hours)
      into v_after
      from public.time_clock_entries where id = v_entry;

    select status::text into v_queue
      from public.agent_queue_state where profile_id = v_subject;
    v_queue := coalesce(v_queue, '(no row)');

    v_status  := coalesce(v_result->>'attendance_status', '(absent)');
    v_applied := coalesce(v_result->>'already_applied', '(absent)');

    -- The idempotent retry an agent's double-click makes.
    v_result := public.attendance_clock_out();
    v_retry  := coalesce(v_result->>'already_applied', '(absent)');

    raise exception using errcode = 'ZZ001', message = 'probe rollback';
  exception
    when sqlstate 'ZZ001' then
      null;                                   -- discard the writes, keep the variables
    when others then
      v_raised := sqlstate || ': ' || sqlerrm; -- a real failure, also discarded
  end;

  insert into public._probe_1193 values
    (1, 'the call raised',                         v_raised),
    (2, 'entry before (clock_out|status|hours)',   v_before),
    (3, 'entry after the call',                    v_after),
    (4, 'queue status after clock-out',            v_queue),
    (5, 'payload attendance_status',               v_status),
    (6, 'payload already_applied (first call)',    v_applied),
    (7, 'payload already_applied (retry)',         v_retry),
    (8, 'entry is untouched again after rollback',
        (select format('%s|%s|%s', clock_out, clock_status, total_hours)
           from public.time_clock_entries where id = v_entry));
end
$probe$;

select n, what, observed from public._probe_1193 order by n;
