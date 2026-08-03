-- New Hope Work Desk v1.10.7 — Extend the user_notifications type domain (stage 8 of 10)
--
-- Spec: .kiro/specs/policy-follow-up-renewals-cancellations (task 7.8)
-- Requirements: 20.8 (and 26.1, 26.2 for the forward-only rules)
--
-- Forward-only, eighth file of the v1.10.x series, and THE ONE FILE IN THE SERIES THAT
-- TOUCHES AN OBJECT OLDER THAN v1.10. Every other v1.10.x file creates new
-- cancellation_* objects and reads nothing older. This one widens the permitted value
-- set of `public.user_notifications.notification_type`, a column created by
-- v0.7.0.sql, from ('turn', 'assignment') to ('turn', 'assignment',
-- 'cancellation_follow_up'), because Requirement 20.8 has an escalation write exactly one
-- notification row carrying that third type.
--
-- Creates no table, adds no column, alters no column type, changes no default, adds and
-- removes no index, adds and removes no policy, changes no privilege, and commits no
-- row change. Its entire committed effect is one check constraint replaced by a wider
-- one of the same name on the same column.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT THE LIVE CATALOG SAYS, AND WHY IT DECIDES THE MECHANISM
-- ═══════════════════════════════════════════════════════════════════════════════
--   Read before this file was written, on the live project:
--     * `notification_type` is plain `text` (pg_type.typtype = 'b'). It is NOT an enum,
--       NOT a domain, and carries NO foreign key to a lookup table.
--     * The value set is enforced by exactly one check constraint,
--       `user_notifications_notification_type_check`, validated, defined as
--       `CHECK ((notification_type = ANY (ARRAY['turn'::text, 'assignment'::text])))`.
--       That is PostgreSQL's normalization of the inline, unnamed
--       `check (notification_type in ('turn', 'assignment'))` written in v0.7.0.sql; the
--       name is the one the server auto-generated then, and this file keeps it byte for
--       byte so that any error-message match on the constraint name still resolves.
--     * Server version 17.6.
--     * 3,980 rows, carrying only 'assignment' (2,031) and 'turn' (1,949).
--     * No trigger on the table, no dependent view, one policy
--       ("Users can read own notifications", SELECT, authenticated), owner `postgres`,
--       row level security enabled but NOT forced.
--     * Nothing anywhere in the database already references 'cancellation_follow_up',
--       so no earlier attempt half-landed.
--
--   Because it is a check constraint and not an enum, the additive
--   `alter type ... add value` path does not apply here. (Had it been an enum, that
--   statement would have been safe on this server: the restriction against running it
--   inside a transaction block was lifted in PostgreSQL 12 and this project is on 17.6.
--   It is recorded because the shape had to be established before the mechanism could be
--   chosen, not because it is used.) PostgreSQL has no `alter constraint ... check` form
--   for check constraints, so widening one is expressible only as a drop of the old
--   constraint followed by an add of the wider one — which is what Requirement 20.8's own
--   wording ("extends the `notification_type` check constraint") and task 7.8's bullet
--   ("Drop and re-add only the ... check constraint") both call for.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- READING OF REQUIREMENT 26.1 FOR THIS FILE — STATED, NOT ASSUMED
-- ═══════════════════════════════════════════════════════════════════════════════
--   Requirement 26.1 excludes from a v1.10.x file "any statement that drops or truncates
--   a table, a column, or a row created by a migration at version v1.9.7 or earlier."
--
--   This file contains one `drop constraint`. The reading applied here is that the
--   statement is permitted, on four grounds, each of which is independently checked
--   below rather than asserted in prose:
--
--     1. A check constraint is none of the three things 26.1 enumerates. It is not a
--        table, not a column, and not a row. The enumeration is specific, and the harm
--        26.1 exists to prevent — losing data written before this series — is a harm a
--        constraint cannot suffer. `public.user_notifications` itself, its nine columns,
--        and all 3,980 of its rows survive this file untouched, and the post-condition
--        block proves that with an md5 fingerprint taken over every stored row before
--        the drop and re-compared after the add.
--
--     2. The replacement is a STRICT SUPERSET. Every value the old constraint permitted,
--        the new one permits. The post-condition does not take that on trust from the
--        text of the two definitions: it extracts the literal set from the OLD definition
--        captured before the drop, unions it with the distinct values actually stored,
--        adds 'cancellation_follow_up', and then attempts a real insert of each value in
--        turn against the NEW constraint, rolling every one of those inserts back. A
--        value that the old domain accepted and the new domain refuses raises and takes
--        the whole file with it. A migration that narrowed the domain would leave stored
--        notification rows unreachable by their own table's constraint; that outcome is
--        made unreachable here.
--
--     3. Both statements are inside one transaction. No other session ever observes
--        `public.user_notifications` without a domain constraint on `notification_type`:
--        the drop and the add are separated by no commit, and the ACCESS EXCLUSIVE lock
--        the drop takes is held until commit. There is no window in which an out-of-domain
--        value could be written.
--
--     4. Requirement 26.2 is untouched. `supabase/migrations/v0.7.0.sql`, which created
--        the table and the original constraint, is not edited, and neither is any other
--        file at v1.9.7 or earlier. The correction is made forward, in a new v1.10.x file,
--        which is precisely the mechanism 26.1 and 26.2 exist to require.
--
--   The narrower reading — that a constraint created before v1.9.7 may not be dropped for
--   any reason — was considered and rejected, because under it Requirement 20.8 would be
--   unsatisfiable by any means: there is no other way to widen a PostgreSQL check
--   constraint, and 20.8 explicitly names extending this constraint as the mechanism. A
--   reading that makes another accepted criterion impossible to satisfy is the wrong
--   reading. If the project prefers the narrower reading, the alternative would be a
--   second `notification_type`-adjacent column or a separate cancellation notification
--   table, and Requirement 20.8 would have to be amended to name it. That is a spec
--   change, not a migration change, and it is not made here.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- WHAT IS DELIBERATELY NOT DONE HERE
-- ═══════════════════════════════════════════════════════════════════════════════
--   * No insert policy is added. `authenticated` holds the INSERT privilege on this table
--     but there is no insert policy, so a client-role insert is refused by row level
--     security today and still is after this file. Requirement 20.8's notification rows
--     are written by server-side code, matching the twenty existing `public` functions
--     that already insert here (notify_turn_changed, notify_work_assignment,
--     renewal_generate_due_notifications, and the rest). Adding a policy is neither in
--     task 7.8's bullet nor needed by 20.8, and RLS on this table belongs to whoever owns
--     it, not to this series.
--   * No `comment on constraint`. Task 7.8 limits this file to the constraint itself.
--   * The TypeScript union in `src/lib/dashboard-data.ts`
--     (`notification_type: "turn" | "assignment"`) is NOT widened here — a migration
--     cannot change it. It has to be widened by the application task that writes the
--     escalation notification, or a `cancellation_follow_up` row will be read back into a
--     value the type does not admit. Recorded here because this file is what makes such a
--     row possible.
--   * `set local lock_timeout` below and the temporary pre-state table are not schema
--     changes: the setting reverts at commit and the table is declared `on commit drop`.
--     Neither survives this transaction in any form, in either the success or the
--     rollback path.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- ROLLBACK PATH
-- ═══════════════════════════════════════════════════════════════════════════════
--   begin;
--     alter table public.user_notifications
--       drop constraint if exists user_notifications_notification_type_check;
--     alter table public.user_notifications
--       add constraint user_notifications_notification_type_check
--         check (notification_type in ('turn', 'assignment'));
--   commit;
--
--   That restores the v0.7.0 domain exactly, and it succeeds only while zero rows carry
--   'cancellation_follow_up'. Once an escalation has written one, the narrow constraint
--   cannot validate and the `add constraint` fails — correctly, because the only way to
--   force it through would be to delete notification rows, which is the thing
--   Requirement 26.1 forbids. So the rollback above is usable in the window before the
--   first escalation notification and not after it. After that point the supported
--   reversal is the code-level one Requirement 26.3 describes: restore the previous
--   application code and leave every applied v1.10.x migration, including this file, in
--   place. A wider domain on a column no reverted code writes is inert — nothing reads
--   the constraint, and the twenty existing writers only ever supply 'turn' or
--   'assignment', both of which this file keeps permitted.

begin;

-- Fail fast rather than queue: the drop and the add each take ACCESS EXCLUSIVE on a table
-- that every signed-in session reads for its alert inbox. Waiting behind a long-running
-- transaction would block those reads for as long as the wait lasted. 3,980 rows validate
-- in milliseconds once the lock is held, so a wait of more than a few seconds means
-- something else is holding the table and this file should abort, not persist.
set local lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. PRE-STATE CAPTURE
--
--    Everything the post-condition block needs in order to prove that nothing was lost.
--    Carried across the DDL in a temporary table because the drop and the add sit between
--    the capture and the check as plain, greppable statements rather than being buried in
--    dynamic SQL. `on commit drop` removes it at the commit below, before the closing
--    verification query runs, so this file leaves no object behind on either path.
--
--    Nothing here is hardcoded: the old domain is read out of the live constraint
--    definition, not copied from v0.7.0.sql, so drift between the repository and the live
--    database cannot make the superset proof vacuous.
-- ═══════════════════════════════════════════════════════════════════════════════
create temporary table _v1107_pre_state on commit drop as
select
  -- Row count, and an md5 over the full text of every row ordered by primary key. The
  -- fingerprint covers notification_type itself, so a single changed type value on a
  -- single row of 3,980 fails the comparison.
  (select count(*) from public.user_notifications)                    as row_count,
  (select md5(coalesce(string_agg(u::text, E'\n' order by u.id), ''))
     from public.user_notifications u)                                as rows_fingerprint,

  -- Per-value histogram: a human-readable form of the same proof, quoted in the failure
  -- message when the fingerprint moves.
  (select coalesce(string_agg(format('%s=%s', s.notification_type, s.n), ', '
                              order by s.notification_type), '(no rows)')
     from (select notification_type, count(*) as n
             from public.user_notifications group by notification_type) s)
                                                                      as type_histogram,

  -- The distinct values actually stored. Every one of these must still be insertable
  -- after the swap, whatever the old constraint happened to say.
  (select coalesce(array_agg(distinct notification_type order by notification_type),
                   '{}'::text[])
     from public.user_notifications)                                  as stored_types,

  -- The constraint being replaced, by name and by definition, as the live server reports
  -- it right now.
  (select c.conname::text from pg_constraint c
    where c.conrelid = 'public.user_notifications'::regclass
      and c.contype = 'c'
      and c.conname = 'user_notifications_notification_type_check')    as constraint_name,
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.user_notifications'::regclass
      and c.contype = 'c'
      and c.conname = 'user_notifications_notification_type_check')    as constraint_def,

  -- Every check constraint on the table that mentions notification_type, so a second one
  -- under a different name cannot be silently left in place to keep enforcing the old
  -- narrow domain after this file widens the named one.
  (select coalesce(array_agg(c.conname::text order by c.conname::text), '{}'::text[])
     from pg_constraint c
    where c.conrelid = 'public.user_notifications'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) like '%notification_type%')      as type_constraints,

  -- The literal value set of the OLD definition, extracted rather than assumed. For
  -- `CHECK ((notification_type = ANY (ARRAY['turn'::text, 'assignment'::text])))` this
  -- yields {assignment, turn}; the `::text` casts sit outside the quotes and are not
  -- picked up.
  (select coalesce(array_agg(distinct m[1] order by m[1]), '{}'::text[])
     from pg_constraint c,
          lateral regexp_matches(pg_get_constraintdef(c.oid), $re$'([^']*)'$re$, 'g') as m
    where c.conrelid = 'public.user_notifications'::regclass
      and c.contype = 'c'
      and c.conname = 'user_notifications_notification_type_check')    as old_domain,

  -- Everything about the table OTHER than the constraint being replaced: columns with
  -- their types, not-null flags and defaults; every other constraint; every index; every
  -- policy; every trigger; the two row-level-security flags. One md5 over the lot. If
  -- this file changed anything it should not have, this moves.
  md5(
      coalesce((select string_agg(format('col %s %s notnull=%s default=%s',
                                         a.attname,
                                         format_type(a.atttypid, a.atttypmod),
                                         a.attnotnull,
                                         coalesce(pg_get_expr(d.adbin, d.adrelid), '-')),
                                  E'\n' order by a.attnum)
                 from pg_attribute a
                 left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                where a.attrelid = 'public.user_notifications'::regclass
                  and a.attnum > 0 and not a.attisdropped), '')
   || coalesce((select string_agg(format('con %s %s', c.conname, pg_get_constraintdef(c.oid)),
                                  E'\n' order by c.conname)
                 from pg_constraint c
                where c.conrelid = 'public.user_notifications'::regclass
                  and c.conname <> 'user_notifications_notification_type_check'), '')
   || coalesce((select string_agg(format('idx %s %s', i.indexname, i.indexdef),
                                  E'\n' order by i.indexname)
                 from pg_indexes i
                where i.schemaname = 'public' and i.tablename = 'user_notifications'), '')
   || coalesce((select string_agg(format('pol %s %s %s using=%s check=%s',
                                         p.policyname, p.cmd, p.roles::text,
                                         coalesce(p.qual, '-'),
                                         coalesce(p.with_check, '-')),
                                  E'\n' order by p.policyname)
                 from pg_policies p
                where p.schemaname = 'public' and p.tablename = 'user_notifications'), '')
   || coalesce((select string_agg(format('trg %s %s', tg.tgname, tg.tgfoid::regproc::text),
                                  E'\n' order by tg.tgname)
                 from pg_trigger tg
                where tg.tgrelid = 'public.user_notifications'::regclass
                  and not tg.tgisinternal), '')
   || coalesce((select string_agg(format('grant %s %s', g.grantee, g.privilege_type), E'\n'
                                  order by g.grantee, g.privilege_type)
                 from information_schema.role_table_grants g
                where g.table_schema = 'public'
                  and g.table_name = 'user_notifications'), '')
   || (select format('rls %s force %s', c.relrowsecurity, c.relforcerowsecurity)
         from pg_class c where c.oid = 'public.user_notifications'::regclass)
  )                                                                   as shape_fingerprint;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. PRE-CONDITIONS
--
--    Refuse to touch anything unless the table is exactly the shape the drop-and-add is
--    safe against. Every failure here raises before the drop, so the transaction ends
--    with the original constraint still in place.
-- ═══════════════════════════════════════════════════════════════════════════════
do $pre$
declare
  v_pre        _v1107_pre_state%rowtype;
  v_outsiders  text;
begin
  select * into v_pre from _v1107_pre_state;

  -- ── The table and the column exist, and the column is still text. A different type
  --    would mean the domain is enforced somewhere other than where this file looks.
  if not exists (select 1 from pg_tables
                  where schemaname = 'public' and tablename = 'user_notifications') then
    raise exception 'public.user_notifications is absent; v1.10.7 has nothing to extend'
      using detail = 'v0.7.0.sql creates it.', hint = 'Nothing has been changed.';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'user_notifications'
       and column_name = 'notification_type' and data_type = 'text') then
    raise exception 'public.user_notifications.notification_type is absent or is not text'
      using detail = 'v1.10.7 extends a text check domain. An enum or a lookup foreign key needs a different mechanism.',
            hint = 'Nothing has been changed.';
  end if;

  -- ── The constraint this file replaces exists, under the name it is about to re-create.
  --    Adding a domain constraint where none exists is a different and riskier operation
  --    than widening one, so it is refused rather than guessed at.
  if v_pre.constraint_name is null then
    raise exception 'user_notifications_notification_type_check is absent'
      using detail = 'v1.10.7 widens an existing domain; it does not impose a new one on a column that currently has none.',
            hint = 'Nothing has been changed. Investigate why the v0.7.0 constraint is missing before re-running.';
  end if;

  -- ── It is the ONLY check constraint mentioning notification_type. A second one would
  --    keep enforcing the narrow domain after this file widens the named one, and
  --    Requirement 20.8's insert would still fail.
  if v_pre.type_constraints is distinct from
       array['user_notifications_notification_type_check']::text[] then
    raise exception 'v1.10.7 found % check constraint(s) on notification_type: %',
                    coalesce(array_length(v_pre.type_constraints, 1), 0),
                    array_to_string(v_pre.type_constraints, ', ')
      using detail = 'Exactly one, named user_notifications_notification_type_check, is expected. This file will not drop a constraint it does not recognise.',
            hint = 'Nothing has been changed.';
  end if;

  -- ── The old domain was readable. An empty extraction would make the superset proof in
  --    the post-condition vacuous.
  if coalesce(array_length(v_pre.old_domain, 1), 0) = 0 then
    raise exception 'v1.10.7 could not read any permitted value out of %', v_pre.constraint_def
      using detail = 'The superset proof depends on knowing what the old constraint allowed.',
            hint = 'Nothing has been changed.';
  end if;

  -- ── THE CENTRAL SAFETY CHECK: every value already stored is inside the domain this
  --    file is about to impose. If any row carried something else, the new constraint
  --    would be a NARROWING relative to the data, the `add constraint` below would fail
  --    validation, and the intent of Requirement 26.1 would be at stake. Checked here so
  --    the failure names the offending values instead of surfacing as a bare
  --    check_violation from the DDL.
  select string_agg(format('%s (%s row(s))', s.notification_type, s.n), ', '
                    order by s.notification_type)
    into v_outsiders
    from (select notification_type, count(*) as n
            from public.user_notifications
           where notification_type not in ('turn', 'assignment', 'cancellation_follow_up')
           group by notification_type) s;
  if v_outsiders is not null then
    raise exception 'v1.10.7 would orphan stored notification rows: %', v_outsiders
      using detail = 'The target domain is turn, assignment, cancellation_follow_up. Rows outside it exist, so this file would narrow the domain relative to the data.',
            hint = 'Nothing has been changed. Widen the target domain to include these values before re-running.';
  end if;

  -- ── Same check from the other direction: nothing the OLD constraint permitted may be
  --    dropped from the new one. Compared as sets, before any DDL runs.
  select string_agg(o.v, ', ' order by o.v) into v_outsiders
    from unnest(v_pre.old_domain) as o(v)
   where o.v not in ('turn', 'assignment', 'cancellation_follow_up');
  if v_outsiders is not null then
    raise exception 'v1.10.7 would remove these permitted values from the domain: %', v_outsiders
      using detail = format('Old constraint: %s. Requirement 26.1 is read here as permitting the swap only because it is a strict superset.',
                            v_pre.constraint_def),
            hint = 'Nothing has been changed.';
  end if;

  raise notice 'v1.10.7 pre-conditions met. Old domain: {%}. % row(s) stored: %.',
               array_to_string(v_pre.old_domain, ', '), v_pre.row_count, v_pre.type_histogram;
end
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. THE ONLY COMMITTED CHANGE IN THIS FILE
--
--    `drop constraint if exists` then `add constraint` under the identical name. The
--    `if exists` is what makes the file re-appliable: a second run drops the already
--    widened constraint and re-adds the same definition, ending in the same state.
--
--    The two statements are adjacent and inside the surrounding transaction. The ACCESS
--    EXCLUSIVE lock taken by the drop is held to commit, so no session observes the
--    column without a domain constraint, and the add re-validates all stored rows before
--    the transaction is allowed to commit — a guarantee the pre-condition above already
--    proved will hold.
--
--    Written as `in (...)`, which is the source form used by v0.7.0.sql. The server
--    normalizes it to `= ANY (ARRAY[...])` in the stored definition, which is why the
--    post-condition matches on the value literals rather than on the operator text.
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.user_notifications
  drop constraint if exists user_notifications_notification_type_check;

alter table public.user_notifications
  add constraint user_notifications_notification_type_check
    check (notification_type in ('turn', 'assignment', 'cancellation_follow_up'));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. POST-CONDITIONS
--
--    Any failure below raises, which rolls this file back to the v0.7.0 domain rather
--    than leaving the table in an unproven state for stages 9 and 10 to build on.
--
--    The acceptance and rejection probes are real inserts. Each one runs inside a nested
--    plpgsql block, which PostgreSQL implements as a subtransaction, and each is undone by
--    an exception raised out of that block — a sentinel SQLSTATE when the insert was
--    accepted, the server's own check_violation when it was refused. Either way the
--    subtransaction rolls back and the row never exists outside it. The row fingerprint
--    re-compared at the end of the block proves that: it is taken over the same 3,980
--    rows, after every probe, and must equal the value captured before the drop.
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_pre                _v1107_pre_state%rowtype;
  v_def                text;
  v_validated          boolean;
  v_new_domain         text[];
  v_expected_domain    text[];
  v_recipient          uuid;
  v_value              text;
  v_refused            text[] := '{}';
  v_out_of_domain_ok   boolean := false;
  v_row_count          bigint;
  v_fingerprint        text;
  v_histogram          text;
  v_shape              text;
  v_probe_title        constant text := 'v1.10.7 post-condition probe';
  v_out_of_domain_val  constant text := 'v1107_out_of_domain_probe';
begin
  select * into v_pre from _v1107_pre_state;

  -- ── The constraint exists again, under the same name, as a validated check on
  --    notification_type. `convalidated` matters: a NOT VALID constraint would not apply
  --    to the 3,980 existing rows and the domain guarantee would be partial.
  select pg_get_constraintdef(c.oid), c.convalidated
    into v_def, v_validated
    from pg_constraint c
   where c.conrelid = 'public.user_notifications'::regclass
     and c.contype = 'c'
     and c.conname = 'user_notifications_notification_type_check';

  if v_def is null then
    raise exception 'v1.10.7 did not re-create user_notifications_notification_type_check'
      using detail = 'The column would be left with no domain constraint at all.',
            hint = 'Rolling back.';
  end if;

  if not v_validated then
    raise exception 'v1.10.7 left user_notifications_notification_type_check NOT VALID: %', v_def
      using detail = 'A NOT VALID check does not constrain the rows that already exist.',
            hint = 'Rolling back.';
  end if;

  if v_def not like '%notification_type%' then
    raise exception 'v1.10.7 re-created the constraint against the wrong column: %', v_def
      using hint = 'Rolling back.';
  end if;

  -- ── Still exactly one check constraint on notification_type, and it is this one.
  if (select count(*) from pg_constraint c
       where c.conrelid = 'public.user_notifications'::regclass
         and c.contype = 'c'
         and pg_get_constraintdef(c.oid) like '%notification_type%') <> 1 then
    raise exception 'v1.10.7 left more than one check constraint on notification_type'
      using hint = 'Rolling back.';
  end if;

  -- ── The new domain, read back out of the live definition the same way the old one was
  --    read, and compared as a set against (old domain + the one new value).
  select coalesce(array_agg(distinct m[1] order by m[1]), '{}'::text[])
    into v_new_domain
    from regexp_matches(v_def, $re$'([^']*)'$re$, 'g') as m;

  select array_agg(distinct x order by x) into v_expected_domain
    from unnest(v_pre.old_domain || array['cancellation_follow_up']::text[]
                                 || v_pre.stored_types) as x;

  if v_new_domain is distinct from v_expected_domain then
    raise exception 'v1.10.7 produced domain {%}, expected {%}',
                    array_to_string(v_new_domain, ', '),
                    array_to_string(v_expected_domain, ', ')
      using detail = format('Old domain was {%s}; stored values were {%s}; the file adds cancellation_follow_up and nothing else.',
                            array_to_string(v_pre.old_domain, ', '),
                            array_to_string(v_pre.stored_types, ', ')),
            hint = 'Rolling back.';
  end if;

  -- ── Requirement 20.8 names the three values explicitly. Assert them by name as well
  --    as by set difference, so a re-run against a drifted old domain still has to end up
  --    with all three.
  if not ('turn' = any (v_new_domain)
          and 'assignment' = any (v_new_domain)
          and 'cancellation_follow_up' = any (v_new_domain)) then
    raise exception 'v1.10.7 left the domain as {%}; Requirement 20.8 needs turn, assignment, and cancellation_follow_up',
                    array_to_string(v_new_domain, ', ')
      using hint = 'Rolling back.';
  end if;

  -- ── A recipient that satisfies the not-null foreign key on recipient_profile_id. Taken
  --    from an existing notification row first, so the probe cannot fail for a reason
  --    unrelated to the domain.
  select u.recipient_profile_id into v_recipient from public.user_notifications u limit 1;
  if v_recipient is null then
    select p.id into v_recipient from public.profiles p limit 1;
  end if;
  if v_recipient is null then
    raise exception 'v1.10.7 found no profile to address a probe notification to'
      using detail = 'recipient_profile_id is not null and references public.profiles(id).',
            hint = 'Rolling back.';
  end if;

  -- ── ACCEPTANCE PROBES. Every value in the expected domain — which includes every value
  --    the old constraint permitted and every value actually stored — is inserted for
  --    real and rolled back. A refusal means this file narrowed the domain under an
  --    existing row, and it takes the migration with it.
  foreach v_value in array v_expected_domain loop
    begin
      insert into public.user_notifications
        (recipient_profile_id, notification_type, title, message)
      values (v_recipient, v_value, v_probe_title, v_probe_title);
      -- Accepted. Undo the subtransaction by raising a sentinel this block catches; the
      -- row is discarded with the failed subtransaction and never reaches the commit.
      raise exception using errcode = 'U0107', message = 'v1.10.7 probe undo';
    exception
      when sqlstate 'U0107' then
        null;
      when check_violation then
        v_refused := array_append(v_refused, v_value);
    end;
  end loop;

  if array_length(v_refused, 1) > 0 then
    raise exception 'v1.10.7 narrowed the domain: the new constraint refuses %',
                    array_to_string(v_refused, ', ')
      using detail = format('Old domain {%s} and stored values {%s} must all remain insertable. New constraint: %s',
                            array_to_string(v_pre.old_domain, ', '),
                            array_to_string(v_pre.stored_types, ', '), v_def),
            hint = 'Rolling back.';
  end if;

  -- ── REJECTION PROBE. The widened constraint must still be a constraint: a value
  --    outside the three permitted ones has to be refused. Same subtransaction
  --    treatment, so this row never exists either.
  begin
    insert into public.user_notifications
      (recipient_profile_id, notification_type, title, message)
    values (v_recipient, v_out_of_domain_val, v_probe_title, v_probe_title);
    raise exception using errcode = 'U0107', message = 'v1.10.7 probe undo';
  exception
    when sqlstate 'U0107' then
      v_out_of_domain_ok := true;
    when check_violation then
      v_out_of_domain_ok := false;
  end;

  if v_out_of_domain_ok then
    raise exception 'v1.10.7 accepted the out-of-domain value %', v_out_of_domain_val
      using detail = format('The constraint no longer restricts anything. Definition: %s', v_def),
            hint = 'Rolling back.';
  end if;

  -- ── REQUIREMENT 26.1 PROOF: not one row changed. Count, per-value histogram, and an
  --    md5 over the full text of every row, all compared against the values captured
  --    before the drop.
  select count(*) into v_row_count from public.user_notifications;
  if v_row_count <> v_pre.row_count then
    raise exception 'v1.10.7 changed the row count of public.user_notifications: % -> %',
                    v_pre.row_count, v_row_count
      using detail = 'Requirement 26.1 forbids dropping a row created at v1.9.7 or earlier. This file writes no row at all.',
            hint = 'Rolling back.';
  end if;

  select coalesce(string_agg(format('%s=%s', s.notification_type, s.n), ', '
                             order by s.notification_type), '(no rows)')
    into v_histogram
    from (select notification_type, count(*) as n
            from public.user_notifications group by notification_type) s;
  if v_histogram is distinct from v_pre.type_histogram then
    raise exception 'v1.10.7 changed the stored notification types: [%] -> [%]',
                    v_pre.type_histogram, v_histogram
      using detail = 'No pre-existing type value may be rewritten or removed.',
            hint = 'Rolling back.';
  end if;

  select md5(coalesce(string_agg(u::text, E'\n' order by u.id), ''))
    into v_fingerprint from public.user_notifications u;
  if v_fingerprint is distinct from v_pre.rows_fingerprint then
    raise exception 'v1.10.7 altered stored notification rows (fingerprint % -> %)',
                    v_pre.rows_fingerprint, v_fingerprint
      using detail = 'The fingerprint covers every column of every row, including notification_type. Probe rows are rolled back and must not appear here.',
            hint = 'Rolling back.';
  end if;

  -- ── "No other statement in the file": every column, every other constraint, every
  --    index, every policy, every trigger, every grant, and both row-level-security flags
  --    are byte for byte what they were before the swap.
  select md5(
      coalesce((select string_agg(format('col %s %s notnull=%s default=%s',
                                         a.attname,
                                         format_type(a.atttypid, a.atttypmod),
                                         a.attnotnull,
                                         coalesce(pg_get_expr(d.adbin, d.adrelid), '-')),
                                  E'\n' order by a.attnum)
                 from pg_attribute a
                 left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                where a.attrelid = 'public.user_notifications'::regclass
                  and a.attnum > 0 and not a.attisdropped), '')
   || coalesce((select string_agg(format('con %s %s', c.conname, pg_get_constraintdef(c.oid)),
                                  E'\n' order by c.conname)
                 from pg_constraint c
                where c.conrelid = 'public.user_notifications'::regclass
                  and c.conname <> 'user_notifications_notification_type_check'), '')
   || coalesce((select string_agg(format('idx %s %s', i.indexname, i.indexdef),
                                  E'\n' order by i.indexname)
                 from pg_indexes i
                where i.schemaname = 'public' and i.tablename = 'user_notifications'), '')
   || coalesce((select string_agg(format('pol %s %s %s using=%s check=%s',
                                         p.policyname, p.cmd, p.roles::text,
                                         coalesce(p.qual, '-'),
                                         coalesce(p.with_check, '-')),
                                  E'\n' order by p.policyname)
                 from pg_policies p
                where p.schemaname = 'public' and p.tablename = 'user_notifications'), '')
   || coalesce((select string_agg(format('trg %s %s', tg.tgname, tg.tgfoid::regproc::text),
                                  E'\n' order by tg.tgname)
                 from pg_trigger tg
                where tg.tgrelid = 'public.user_notifications'::regclass
                  and not tg.tgisinternal), '')
   || coalesce((select string_agg(format('grant %s %s', g.grantee, g.privilege_type), E'\n'
                                  order by g.grantee, g.privilege_type)
                 from information_schema.role_table_grants g
                where g.table_schema = 'public'
                  and g.table_name = 'user_notifications'), '')
   || (select format('rls %s force %s', c.relrowsecurity, c.relforcerowsecurity)
         from pg_class c where c.oid = 'public.user_notifications'::regclass)
  ) into v_shape;
  if v_shape is distinct from v_pre.shape_fingerprint then
    raise exception 'v1.10.7 changed something other than the notification_type check constraint'
      using detail = 'Columns, other constraints, indexes, policies, triggers, grants, and the row-level-security flags must all be unchanged. Task 7.8 permits no other statement.',
            hint = 'Rolling back.';
  end if;

  raise notice 'v1.10.7: domain {%} -> {%}; % row(s) unchanged (%); out-of-domain value still refused.',
               array_to_string(v_pre.old_domain, ', '),
               array_to_string(v_new_domain, ', '),
               v_row_count, v_histogram;
end
$post$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
select
  (select count(*) from pg_constraint
    where conrelid = 'public.user_notifications'::regclass
      and contype = 'c'
      and conname = 'user_notifications_notification_type_check')  as named_check_expect_1,
  (select count(*) from pg_constraint
    where conrelid = 'public.user_notifications'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%notification_type%')    as type_checks_expect_1,
  (select convalidated from pg_constraint
    where conrelid = 'public.user_notifications'::regclass
      and conname = 'user_notifications_notification_type_check')  as validated_expect_true,
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.user_notifications'::regclass
      and conname = 'user_notifications_notification_type_check')  as new_constraint_definition,
  (select array_agg(distinct m[1] order by m[1])
     from pg_constraint c,
          lateral regexp_matches(pg_get_constraintdef(c.oid), $re$'([^']*)'$re$, 'g') as m
    where c.conrelid = 'public.user_notifications'::regclass
      and c.conname = 'user_notifications_notification_type_check') as domain_expect_3_values,
  (select count(*) from pg_constraint
    where conrelid = 'public.user_notifications'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%cancellation_follow_up%') as allows_followup_expect_1,
  (select count(*) from public.user_notifications)                as rows_expect_3980_unchanged,
  (select count(*) from public.user_notifications
    where notification_type = 'turn')                             as turn_rows_expect_1949,
  (select count(*) from public.user_notifications
    where notification_type = 'assignment')                       as assignment_rows_expect_2031,
  (select count(*) from public.user_notifications
    where notification_type = 'cancellation_follow_up')           as followup_rows_expect_0_until_req_20_8,
  (select count(*) from public.user_notifications
    where notification_type not in ('turn', 'assignment', 'cancellation_follow_up'))
                                                                  as out_of_domain_rows_expect_0,
  (select count(*) from public.user_notifications
    where title = 'v1.10.7 post-condition probe')                 as probe_residue_expect_0,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'user_notifications')
                                                                  as columns_expect_9_unchanged,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'user_notifications')
                                                                  as policies_expect_1_unchanged,
  (select count(*) from pg_indexes
    where schemaname = 'public' and tablename = 'user_notifications')
                                                                  as indexes_expect_3_unchanged,
  (select count(*) from pg_class
    where oid = 'public.user_notifications'::regclass and relrowsecurity)
                                                                  as rls_expect_still_enabled,
  (select count(*) from pg_tables where schemaname like 'pg_temp%'
     and tablename = '_v1107_pre_state')                          as temp_state_expect_0_after_commit;
