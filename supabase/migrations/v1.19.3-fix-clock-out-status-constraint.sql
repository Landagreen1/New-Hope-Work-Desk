-- v1.19.3 — Clock-out is refused by time_clock_entries_clock_status_check
--
-- SYMPTOM
--   Every agent clock-out failed with:
--     "Clock action not recorded
--      new row for relation "time_clock_entries" violates check constraint
--      "time_clock_entries_clock_status_check""
--   Confirmed live: all 30 of today's entries were open, and every entry on the
--   previous working day closed normally, so the break arrived with the function
--   body, not with the data.
--
-- CAUSE
--   `v1.19.0-agent-queue-state-v2.sql` rewrote `public.attendance_clock_out` to
--   drive the queue transition through `transition_agent_queue_status`, and in the
--   same rewrite added a write that had never been there before:
--
--       update public.time_clock_entries
--          set clock_out = v_now,
--              clock_status = 'completed',   -- <— new in v1.19.0
--              total_hours = v_total_hours
--        where id = v_entry_id;
--
--   `clock_status` has carried a closed vocabulary since `v1.2.0-time-attendance.sql`:
--
--       check (clock_status in ('available', 'lunch', 'unavailable'))
--
--   'completed' is not in it, so the UPDATE aborts. Postgres words a CHECK failure
--   on an UPDATE as "new row for relation", which is why the message reads like an
--   insert. The whole function is one transaction, so the aborted UPDATE takes the
--   break close and the queue transition down with it: the agent stays clocked in
--   and stays in the rotations.
--
-- WHY THE COLUMN IS NOT WIDENED
--   `clock_status` is the *status held during* the session — the column comment in
--   v1.2.0 is "Status at clock-in (maps to existing availability_status)" — and it is
--   the column `attendance_break_start` / `attendance_break_end` move between 'lunch'
--   and 'available'. Completion is not one of its values: it is expressed by
--   `clock_out is not null`, which is what `uniq_time_clock_open_entry`,
--   `idx_time_clock_active` and every attendance read already key off.
--
--   Nothing anywhere consumes a 'completed' clock status. The TypeScript type is
--   `export type ClockStatus = 'available' | 'lunch' | 'unavailable'`
--   (`src/features/time-attendance/types.ts`), and `CLOCK_STATUS_STYLES` is a
--   `Record<ClockStatus, ...>` — a 'completed' value would read back as `undefined`
--   and break the badge render. The 'completed' that the UI does show is
--   `DerivedStatus`, computed from the sessions of a work date by
--   `src/features/time-attendance/domain/attendance.ts` (rule AS-10); it never reads
--   this column. Widening the constraint would therefore trade a hard failure for a
--   value no reader understands.
--
-- THE FIX
--   Recreate `attendance_clock_out` with the v1.19.0 body byte-for-byte except for
--   the `clock_status` assignment, which is dropped. Restores the pre-v1.19.0
--   behaviour of leaving `clock_status` as the session's last held status while
--   keeping everything v1.19.0 introduced: the `for update` lock, the idempotent
--   already-clocked-out answer, the open-break close, the arithmetic, and the
--   `transition_agent_queue_status` call with source `attendance_clock_out`.
--
--   No data repair is needed. The UPDATE aborted atomically every time, so no row
--   ever received 'completed'; the affected agents simply still have an open entry
--   and can clock out normally once this lands.
--
-- ── ROLLBACK
--   Re-apply the `attendance_clock_out` definition from
--   `v1.19.0-agent-queue-state-v2.sql`. Note that doing so re-breaks clock-out.

begin;

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

  -- Lock the open entry and re-assert that it is still open. In READ COMMITTED the
  -- qualification is re-evaluated after the lock is granted, so the loser of two
  -- concurrent clock-outs, or a double-clicked retry, finds no row here and is
  -- answered with the committed state rather than an error.
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

  -- `clock_status` is deliberately untouched. Completion is `clock_out is not null`;
  -- the column's vocabulary is ('available', 'lunch', 'unavailable') and writing
  -- 'completed' here is what v1.19.0 broke.
  update public.time_clock_entries
     set clock_out = v_now,
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

grant execute on function public.attendance_clock_out() to authenticated, service_role;

commit;

-- Verification. The body still mentions `clock_status` in the comment above the
-- UPDATE, so the test is for an assignment, not for the word.
select
  pg_get_functiondef(p.oid) not like '%clock_status =%'            as clock_status_write_removed,
  pg_get_functiondef(p.oid) like '%transition_agent_queue_status%' as queue_transition_kept,
  pg_get_functiondef(p.oid) like '%for update%'                    as row_lock_kept
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'attendance_clock_out';
