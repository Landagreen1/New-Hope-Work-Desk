-- New Hope Work Desk v1.13.7 — Cancellation audit event_type vocabulary (forward-only)
--
-- Fixes: "new row for relation "cancellation_events" violates check constraint
--         "cancellation_events_event_type_check""
--
-- Forward-only. Does not modify historical migrations. Does not alter any table other than
-- the one CHECK constraint named below, and adds no column, index, policy, or function.
--
-- ── WHAT WAS WRONG
--
-- Two vocabularies for `cancellation_events.event_type` were written independently and never
-- reconciled:
--
--   * The database CHECK, last set by v1.10.10 section 2, admits 17 coarse values
--     ('assignment', 'status_change', 'correction', 'suppression_set', 'verification', ...).
--   * The application writes a finer vocabulary, declared as `CANCELLATION_EVENT_TYPES` in
--     `src/features/cancellations/api.ts` plus one exported constant per domain module
--     ('case_assigned', 'case_status_overridden', 'imported_data_corrected',
--     'contact_opt_out_recorded', 'verification_outcome_recorded', ...).
--
-- The `api.ts` comment above that vocabulary explains how the two drifted apart: it states the
-- column "is free text, so the vocabulary lives here rather than in a check constraint". That
-- was true when it was written. v1.10.10 then added a CHECK without reconciling it against what
-- the application already wrote, and the comment was never revisited.
--
-- Eleven of the eighteen event types the application writes were therefore rejected by the
-- live database, which broke the audit write on these paths:
--
--   adding a contact, changing a contact's preferred language, changing a contact's
--   authorization status, recording a customer response, recording a verification outcome,
--   overriding a case status, assigning or claiming a case, changing automatic sending,
--   correcting imported data, recording a contact opt-out, and clearing a suppression.
--
-- The damage was worse than a visible error. Every one of those paths performs its primary
-- write first and appends the audit entry second, so the operation itself succeeded and only
-- the timeline entry was refused: the agent saw a failure message for work that had actually
-- been done, and the audit trail lost the entry that explains it. Requirement 22.8 makes the
-- timeline the record of who changed what, so a silently missing entry is the failure mode
-- this constraint was supposed to prevent.
--
-- ── WHY THE CONSTRAINT MOVES AND THE APPLICATION DOES NOT
--
-- The drawer timeline renders `readableLabel(event.event_type)`, a generic snake_case to Title
-- Case transform, so it displays whatever is stored and neither vocabulary is baked into the
-- interface. Both directions would therefore render. The constraint is the side that moves
-- because:
--
--   1. The finer vocabulary carries strictly more information. 'case_status_overridden' and
--      'case_assigned' both collapse to 'status_change'/'assignment' under the coarse list, and
--      a timeline reading "Case Status Overridden" answers a question that "Status Change" does
--      not.
--   2. Widening is additive and cannot invalidate a stored row. Renaming the application's
--      vocabulary would leave already-stored rows spelled the old way, so the timeline would
--      hold two spellings of the same event forever.
--
-- The union is taken rather than a replacement: all 17 existing values are kept, because the
-- server-side functions in v1.10.5, v1.10.10, v1.13.3, and v1.13.6 write 'imported',
-- 'import_updated', 'assignment', and 'follow_up', and the 21 rows already stored live are
-- 'escalation_raised' and 'imported'. Nothing that validates today stops validating.
--
-- ── ROLLBACK
--   alter table public.cancellation_events drop constraint if exists cancellation_events_event_type_check;
--   alter table public.cancellation_events add constraint cancellation_events_event_type_check
--     check (event_type in (
--       'imported', 'import_updated', 'status_change', 'assignment',
--       'communication_sent', 'communication_failed', 'communication_retry',
--       'suppression_set', 'suppression_cleared', 'escalation_raised',
--       'escalation_cleared', 'payment_reported', 'verification',
--       'note_added', 'correction', 'send_blocked', 'follow_up'));
--   -- Safe only while no row carries one of the 11 values added below.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Widen event_type to the union of the database and application vocabularies
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.cancellation_events
  drop constraint if exists cancellation_events_event_type_check;

alter table public.cancellation_events
  add constraint cancellation_events_event_type_check
  check (event_type in (
    -- ── The 17 values v1.10.10 admitted. Written by the server-side functions in
    --    v1.10.5 (cancellation_import_batch), v1.10.10, v1.13.3 (assignment engine),
    --    and v1.13.6 (collector import), and by the scheduler.
    'imported',
    'import_updated',
    'status_change',
    'assignment',
    'communication_sent',
    'communication_failed',
    'communication_retry',
    'suppression_set',
    'suppression_cleared',
    'escalation_raised',
    'escalation_cleared',
    'payment_reported',
    'verification',
    'note_added',
    'correction',
    'send_blocked',
    'follow_up',

    -- ── CANCELLATION_EVENT_TYPES, src/features/cancellations/api.ts.
    --    'note_added' and 'payment_reported' are in that object too and appear above.
    'contact_added',
    'contact_preferred_language_changed',
    'contact_authorization_changed',
    'customer_response_recorded',
    'verification_outcome_recorded',
    'case_status_overridden',
    'case_assigned',
    'automatic_sending_changed',

    -- ── One exported constant per domain module.
    --    IMPORTED_DATA_CORRECTED_EVENT   src/features/cancellations/manager-api.ts
    --    OPT_OUT_EVENT_TYPE              src/features/cancellations/domain/suppression.ts
    --    SUPPRESSION_CLEARED_EVENT_TYPE  src/features/cancellations/domain/suppression.ts
    'imported_data_corrected',
    'contact_opt_out_recorded',
    'contact_suppression_cleared'));

comment on constraint cancellation_events_event_type_check on public.cancellation_events is
  'The audit timeline vocabulary, v1.13.7. Union of the values the server-side functions write and CANCELLATION_EVENT_TYPES plus the per-module event constants in src/features/cancellations. Adding an event type to the application requires adding it here in the same change, which src/features/cancellations/__tests__/event-type-vocabulary.test.ts enforces.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Post-conditions — proves the constraint admits every value the application
--    writes and still refuses an unknown one, then rolls the probe rows back.
-- ═══════════════════════════════════════════════════════════════════════════════

do $$
declare
  v_expected text[] := array[
    'imported', 'import_updated', 'status_change', 'assignment',
    'communication_sent', 'communication_failed', 'communication_retry',
    'suppression_set', 'suppression_cleared', 'escalation_raised',
    'escalation_cleared', 'payment_reported', 'verification',
    'note_added', 'correction', 'send_blocked', 'follow_up',
    'contact_added', 'contact_preferred_language_changed',
    'contact_authorization_changed', 'customer_response_recorded',
    'verification_outcome_recorded', 'case_status_overridden', 'case_assigned',
    'automatic_sending_changed', 'imported_data_corrected',
    'contact_opt_out_recorded', 'contact_suppression_cleared'];
  v_type      text;
  v_case_id   uuid;
  v_admitted  boolean;
  v_refused   boolean := false;
  v_rows      bigint;
begin
  -- The constraint must exist and be a check constraint on this table.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.cancellation_events'::regclass
       and conname  = 'cancellation_events_event_type_check'
       and contype  = 'c'
  ) then
    raise exception 'v1.13.7 did not leave cancellation_events_event_type_check in place'
      using hint = 'Rolling back.';
  end if;

  -- Every already-stored row must still satisfy the widened constraint. Widening cannot
  -- invalidate a row, but the check is cheap and proves the union was not mistyped.
  select count(*) into v_rows
    from public.cancellation_events
   where event_type <> all (v_expected);
  if v_rows <> 0 then
    raise exception 'v1.13.7 would orphan % stored cancellation_events row(s) whose event_type is outside the new vocabulary', v_rows
      using detail = 'A stored audit entry cannot be rewritten (Requirement 22.8), so the constraint must admit it.',
            hint   = 'Rolling back.';
  end if;

  -- A real insert per event type, inside a savepoint, against a real case row. This is the
  -- only check that proves the constraint admits the value rather than that the text of the
  -- migration mentions it.
  begin
    insert into public.cancellation_cases (
      policy_number, cancellation_effective_date, customer_name, case_status,
      raw_row, raw_header)
    values ('V1137-POSTCONDITION-PROBE', current_date, 'v1.13.7 post-condition probe', 'Imported',
      '[]'::jsonb, array[]::text[])
    returning id into v_case_id;

    foreach v_type in array v_expected loop
      v_admitted := true;
      begin
        insert into public.cancellation_events (case_id, event_type, detail)
        values (v_case_id, v_type, jsonb_build_object('probe', 'v1.13.7'));
      exception when check_violation then
        v_admitted := false;
      end;
      if not v_admitted then
        raise exception 'v1.13.7 left event_type %L refused by the check constraint', v_type
          using detail = 'The application writes this value, so the audit entry would be lost.',
                hint   = 'Rolling back.';
      end if;
    end loop;

    -- And an unknown value must still be refused, so the constraint is a guard and not a
    -- formality that a typo could slip through.
    begin
      insert into public.cancellation_events (case_id, event_type, detail)
      values (v_case_id, 'v1137_not_a_real_event_type', '{}'::jsonb);
    exception when check_violation then
      v_refused := true;
    end;
    if not v_refused then
      raise exception 'v1.13.7 left cancellation_events.event_type accepting an unknown value'
        using detail = 'The check constraint is the typo guard for the audit vocabulary.',
              hint   = 'Rolling back.';
    end if;

    -- Discard the probe. The append-only trigger refuses delete even on this path, so the
    -- rows are removed by raising out of the block rather than by deleting them.
    raise exception 'v1137_probe_done' using errcode = 'RS001';
  exception
    when sqlstate 'RS001' then null;
  end;

  raise notice 'v1.13.7: cancellation_events.event_type admits all % application values and refuses an unknown one.',
               cardinality(v_expected);
end $$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Verification — run after commit; expects 28 and the full list.
-- ═══════════════════════════════════════════════════════════════════════════════

select
  (select count(*) from unnest(string_to_array(
     regexp_replace(pg_get_constraintdef(oid), '^.*ARRAY\[|\].*$', '', 'g'), ','))
   ) as admitted_values,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.cancellation_events'::regclass
  and conname = 'cancellation_events_event_type_check';
