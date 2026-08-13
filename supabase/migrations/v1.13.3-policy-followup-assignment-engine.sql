-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.13.3 — The Policy Follow-up assignment engine
--
-- Spec: .kiro/specs/policy-follow-up-assignment-workflow
-- Requirements: 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 13.1, 13.2, 14.2
-- Design: 4.3, 6.2, 6.3
--
-- Forward-only and additive: this migration creates functions only. It alters no table,
-- replaces no pre-existing function, and writes no row.
--
-- ── What the engine is for
--
-- Requirement 3.3 fixes one precedence for every new or newly-unowned policy, and the
-- whole point of it is that no import may quietly move work that already has an owner:
--
--   1. a manager lock                      -> preserved, always
--   2. the existing shared policy owner    -> preserved across reimports and both domains
--   3. an existing valid domain owner      -> bootstrapped, not reassigned
--   4. the imported producer label         -> resolved to an employee
--   5. weighted workload balancing         -> unowned, reliable records only
--   6. manager review                      -> everything else, left visibly unowned
--
-- Requirement 4.5 is the other half: balancing decides where *unowned* work goes and must
-- never move owned work. That is a structural property here, not a rule anyone has to
-- remember — step 5 is only reachable after steps 1 through 4 have all found nothing, and
-- steps 1 through 3 return early whenever any owner exists.
--
-- ── Why this is in SQL and not in the client
--
-- Requirement 4.3 requires two simultaneous imports not be able to select the same
-- "lowest workload" employee from stale state. `policy_followup_resolve_owner` takes a
-- transaction-scoped advisory lock keyed on the policy identity and then a row lock on the
-- owner row, so a second caller for the same policy waits and re-reads rather than racing;
-- and the workload score is computed inside the same transaction as the write that acts on
-- it, so it cannot be stale by construction.
--
-- ── What it does not touch
--
-- Nothing here reads or writes `rotation_state`, `turn_events`, `quote_take_events`, any
-- rotation position, any availability column, or any attendance state. Policy Follow-up
-- eligibility is a separate concept from queue eligibility and the two share no storage.
-- ═══════════════════════════════════════════════════════════════════════════════

do $pre$
begin
  if not exists (select 1 from pg_tables
                  where schemaname = 'public' and tablename = 'policy_followup_policy_owners') then
    raise exception 'v1.13.3 requires v1.13.0' using hint = 'Nothing was created.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'cancellation_cases' and column_name = 'carrier_key'
  ) then
    raise exception 'v1.13.3 requires v1.13.2' using hint = 'Nothing was created.';
  end if;
end;
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. STATUS SETS
--
--    Named once so the workload query, the overview, and the engine cannot disagree about
--    what "open" and "active" mean. These mirror `OPEN_STATUSES` in
--    src/features/renewals/api.ts and `ACTIVE_CASE_STATUSES` in
--    src/features/cancellations/derive.ts.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_open_renewal_statuses()
returns text[] language sql immutable as $$
  select array['imported', 'assigned', 'in_progress', 'monitoring', 'requote_sent'];
$$;

create or replace function public.policy_followup_active_case_statuses()
returns text[] language sql immutable as $$
  select array['Imported', 'Open', 'Payment Reported', 'Verification Pending', 'Reinstatement Pending'];
$$;

comment on function public.policy_followup_open_renewal_statuses() is
  'The five renewal_records.status values that are open work. Mirrors OPEN_STATUSES in src/features/renewals/api.ts.';
comment on function public.policy_followup_active_case_statuses() is
  'The five cancellation_cases.case_status values that are active work. Mirrors ACTIVE_CASE_STATUSES in src/features/cancellations/derive.ts.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. REQUOTE ACTIVITY (Requirements 5.2, 7.2, 9.2)
--
--    One definition of "has a requote been started", used by the workload score, the
--    Manager Overview non-renewal count, and the Critical bucket. Mirrors
--    `hasRequoteActivity` in src/features/renewals/derive.ts, including the five
--    `renewal_events` types of REQUOTE_EVENT_TYPES.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_requote_started(p_record_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
      select 1 from public.renewal_records record
       where record.id = p_record_id
         and (record.requote_sent_at is not null
              or record.requote_intake_id is not null
              or record.requote_work_item_id is not null))
      or exists (
      select 1 from public.renewal_events event
       where event.record_id = p_record_id
         and event.event_type in ('requote_intake_draft_created', 'requote_intake_submitted',
                                  'requote_quote_created', 'requote_created',
                                  'requote_work_item_created'));
$$;

comment on function public.policy_followup_requote_started(uuid) is
  'True where a requote has been started for a renewal: a stored requote reference, or one of the five REQUOTE_EVENT_TYPES entries. Mirrors hasRequoteActivity in src/features/renewals/derive.ts. Requirements 5.2, 7.2.';

grant execute on function public.policy_followup_requote_started(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. WORKLOAD POINTS (Requirement 4.2, design 6.1, 6.2)
--
--    Two scalar functions, each reading `policy_followup_workload_weights`, each mirroring
--    its TypeScript twin in src/features/policy-follow-up/workload.ts exactly:
--
--      * the date bands are a *band*, not a running total — a renewal due in two days
--        scores the 3-day band's 5 points, not 1+2+3+4+5;
--      * Carrier Non-Renewal and payment verification are folded in with `greatest`, so
--        their points describe a floor rather than an addend;
--      * a date already past scores the tightest band, because Requirement 4.2's bands are
--        written forward-looking and treating a slipped date as the least urgent case would
--        be exactly backwards;
--      * a closed or resolved record scores zero (Requirement 4.4).
--
--    The post-condition block at the end of this file asserts the boundary values against
--    the same numbers the TypeScript tests pin, which is what keeps the two in step.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_renewal_points(
  p_closed boolean,
  p_renewal_date date,
  p_carrier_nonrenewal boolean,
  p_next_follow_up timestamptz,
  p_business_date date)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_points integer;
  w record;
begin
  if coalesce(p_closed, false) then return 0; end if;

  select
    max(case when key = 'renewal_open' then points end)              as open,
    max(case when key = 'renewal_due_30' then points end)            as due_30,
    max(case when key = 'renewal_due_15' then points end)            as due_15,
    max(case when key = 'renewal_due_7' then points end)             as due_7,
    max(case when key = 'renewal_due_3' then points end)             as due_3,
    max(case when key = 'renewal_nonrenewal' then points end)        as nonrenewal,
    max(case when key = 'renewal_overdue_followup' then points end)  as overdue_followup
    into w
    from public.policy_followup_workload_weights;

  v_points := case
    when p_renewal_date is null                        then w.open
    when p_renewal_date <= p_business_date + 3         then w.due_3
    when p_renewal_date <= p_business_date + 7         then w.due_7
    when p_renewal_date <= p_business_date + 15        then w.due_15
    when p_renewal_date <= p_business_date + 30        then w.due_30
    else w.open
  end;

  if coalesce(p_carrier_nonrenewal, false) then
    v_points := greatest(v_points, w.nonrenewal);
  end if;

  if p_next_follow_up is not null
     and (p_next_follow_up at time zone 'UTC')::date <= p_business_date then
    v_points := v_points + w.overdue_followup;
  end if;

  return v_points;
end;
$fn$;

comment on function public.policy_followup_renewal_points(boolean, date, boolean, timestamptz, date) is
  'Workload points of one renewal. Mirrors renewalWorkloadPoints in src/features/policy-follow-up/workload.ts: banded base, non-renewal as a floor, overdue follow-up additive, zero when closed. Requirements 4.2, 4.4.';

create or replace function public.policy_followup_cancellation_points(
  p_closed boolean,
  p_effective_date date,
  p_payment_verification boolean,
  p_manual_communication boolean,
  p_follow_up_deadline timestamptz,
  p_business_date date)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_points integer;
  w record;
begin
  if coalesce(p_closed, false) then return 0; end if;

  select
    max(case when key = 'cancellation_active' then points end)               as active,
    max(case when key = 'cancellation_due_15' then points end)              as due_15,
    max(case when key = 'cancellation_due_10' then points end)              as due_10,
    max(case when key = 'cancellation_due_5' then points end)               as due_5,
    max(case when key = 'cancellation_due_1' then points end)               as due_1,
    max(case when key = 'cancellation_payment_verification' then points end) as verification,
    max(case when key = 'cancellation_communication_manual' then points end) as manual_comm,
    max(case when key = 'cancellation_overdue_followup' then points end)    as overdue_followup
    into w
    from public.policy_followup_workload_weights;

  v_points := case
    when p_effective_date is null                  then w.active
    when p_effective_date <= p_business_date + 1   then w.due_1
    when p_effective_date <= p_business_date + 5   then w.due_5
    when p_effective_date <= p_business_date + 10  then w.due_10
    when p_effective_date <= p_business_date + 15  then w.due_15
    else w.active
  end;

  if coalesce(p_payment_verification, false) then
    v_points := greatest(v_points, w.verification);
  end if;

  if coalesce(p_manual_communication, false) then
    v_points := v_points + w.manual_comm;
  end if;

  if p_follow_up_deadline is not null
     and (p_follow_up_deadline at time zone 'UTC')::date <= p_business_date then
    v_points := v_points + w.overdue_followup;
  end if;

  return v_points;
end;
$fn$;

comment on function public.policy_followup_cancellation_points(boolean, date, boolean, boolean, timestamptz, date) is
  'Workload points of one cancellation. Mirrors cancellationWorkloadPoints in src/features/policy-follow-up/workload.ts: banded base, payment verification as a floor, manual communication and overdue follow-up additive, zero when resolved. Requirements 4.2, 4.4.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. PER-EMPLOYEE WORKLOAD (Requirements 4.1, 4.4, 9.4)
--
--    `policy_followup_workload_rows` computes over the *whole* population, so it cannot be
--    exposed to an agent: Requirement 4.4 gives the score to managers, and an agent has no
--    business reading a colleague's book. Execute is therefore revoked from PUBLIC, which
--    leaves it callable only by the other security definer functions in this file — they
--    run as the owner — and by the manager-gated wrapper below.
--
--    The cancellation half reads the *stored* `communication_status` column rather than
--    re-deriving it. That column is maintained by
--    `cancellation_recompute_communication_status`, so reading it is reading the output of
--    the one authoritative communication engine rather than building a second one, which
--    Requirement 5.3 and design 7.3 both require.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_workload_rows(p_business_date date default null)
returns table (
  profile_id uuid,
  display_name text,
  username text,
  role text,
  renewals_enabled boolean,
  cancellations_enabled boolean,
  auto_assignment_enabled boolean,
  assignment_mode text,
  active_renewals integer,
  active_cancellations integer,
  due_today integer,
  overdue integer,
  critical_cancellations integer,
  carrier_non_renewals integer,
  waiting integer,
  workload_score integer
)
language sql
stable
security definer
set search_path = public
as $$
with business as (
  select coalesce(p_business_date, (now() at time zone 'America/New_York')::date) as day
),
agents as (
  select * from public.policy_followup_eligible_agents(null)
),
renewal_work as (
  select
    record.assigned_to as profile_id,
    1 as active_renewal,
    0 as active_cancellation,
    case when (record.next_follow_up_at at time zone 'UTC')::date = business.day then 1 else 0 end as due_today,
    case when (record.next_follow_up_at at time zone 'UTC')::date < business.day then 1 else 0 end as overdue,
    0 as critical_cancellation,
    case
      when (record.source_state_normalized = 'carrier_nonrenewal' or record.requote_requested)
           and not public.policy_followup_requote_started(record.id)
      then 1 else 0
    end as carrier_non_renewal,
    case when record.status::text in ('monitoring', 'requote_sent') then 1 else 0 end as waiting,
    public.policy_followup_renewal_points(
      false,
      record.renewal_date,
      (record.source_state_normalized = 'carrier_nonrenewal' or record.requote_requested),
      record.next_follow_up_at,
      business.day) as points
  from public.renewal_records record
  cross join business
  where record.assigned_to is not null
    and record.status::text = any(public.policy_followup_open_renewal_statuses())
),
cancellation_work as (
  select
    kase.assigned_to as profile_id,
    0 as active_renewal,
    1 as active_cancellation,
    case when (kase.follow_up_deadline at time zone 'UTC')::date = business.day then 1 else 0 end as due_today,
    case when (kase.follow_up_deadline at time zone 'UTC')::date < business.day then 1 else 0 end as overdue,
    case
      when kase.cancellation_effective_date <= business.day + 3
        or (kase.follow_up_deadline at time zone 'UTC')::date <= business.day
        or kase.communication_status in ('Failed', 'Partially Failed')
      then 1 else 0
    end as critical_cancellation,
    0 as carrier_non_renewal,
    case
      when kase.case_status in ('Payment Reported', 'Verification Pending', 'Reinstatement Pending')
      then 1 else 0
    end as waiting,
    public.policy_followup_cancellation_points(
      false,
      kase.cancellation_effective_date,
      kase.case_status in ('Payment Reported', 'Verification Pending', 'Reinstatement Pending'),
      kase.communication_status in ('Failed', 'Partially Failed', 'Suppressed', 'Manual Follow-up Required'),
      kase.follow_up_deadline,
      business.day) as points
  from public.cancellation_cases kase
  cross join business
  where kase.assigned_to is not null
    and kase.case_status = any(public.policy_followup_active_case_statuses())
),
combined as (
  select * from renewal_work
  union all
  select * from cancellation_work
),
totals as (
  select
    profile_id,
    sum(active_renewal)::integer       as active_renewals,
    sum(active_cancellation)::integer  as active_cancellations,
    sum(due_today)::integer            as due_today,
    sum(overdue)::integer              as overdue,
    sum(critical_cancellation)::integer as critical_cancellations,
    sum(carrier_non_renewal)::integer  as carrier_non_renewals,
    sum(waiting)::integer              as waiting,
    sum(points)::integer               as workload_score
  from combined
  group by profile_id
)
select
  agents.profile_id,
  agents.display_name,
  agents.username,
  agents.role,
  agents.renewals_enabled,
  agents.cancellations_enabled,
  agents.auto_assignment_enabled,
  agents.assignment_mode,
  coalesce(totals.active_renewals, 0),
  coalesce(totals.active_cancellations, 0),
  coalesce(totals.due_today, 0),
  coalesce(totals.overdue, 0),
  coalesce(totals.critical_cancellations, 0),
  coalesce(totals.carrier_non_renewals, 0),
  coalesce(totals.waiting, 0),
  coalesce(totals.workload_score, 0)
from agents
left join totals on totals.profile_id = agents.profile_id
order by
  coalesce(totals.overdue, 0) desc,
  coalesce(totals.critical_cancellations, 0) desc,
  coalesce(totals.workload_score, 0) desc,
  agents.display_name;
$$;

comment on function public.policy_followup_workload_rows(date) is
  'Per-employee Policy Follow-up workload over the whole population, ordered most at risk first. Internal: execute is revoked from PUBLIC because Requirement 4.4 gives the score to managers only. Requirements 4.1, 4.4, 9.4.';

-- Supabase sets default privileges granting execute on new public functions to `anon` and
-- `authenticated`, so revoking from PUBLIC alone would leave both roles able to call this.
-- All three are revoked explicitly, which leaves the function reachable only by the other
-- security definer functions in this file — they run as the owner — and by the manager-gated
-- wrapper below.
revoke execute on function public.policy_followup_workload_rows(date) from public, anon, authenticated;

create or replace function public.policy_followup_agent_workload(p_business_date date default null)
returns table (
  profile_id uuid,
  display_name text,
  username text,
  role text,
  renewals_enabled boolean,
  cancellations_enabled boolean,
  auto_assignment_enabled boolean,
  assignment_mode text,
  active_renewals integer,
  active_cancellations integer,
  due_today integer,
  overdue integer,
  critical_cancellations integer,
  carrier_non_renewals integer,
  waiting integer,
  workload_score integer
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if not public.policy_followup_is_manager() then
    raise exception 'Manager access is required to read Policy Follow-up workload.'
      using errcode = 'insufficient_privilege',
            detail = 'Requirement 4.4 gives the workload score to Manager_Role.',
            hint = 'Nothing was read.';
  end if;

  return query select * from public.policy_followup_workload_rows(p_business_date);
end;
$fn$;

comment on function public.policy_followup_agent_workload(date) is
  'Manager-gated read of per-employee Policy Follow-up workload. Requirements 4.4, 9.4, 14.2.';

grant execute on function public.policy_followup_agent_workload(date) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. PRODUCER RESOLUTION (Requirement 3.3 step 4)
--
--    The agency has exactly one import-label-to-employee mapping —
--    `public.renewal_assignment_aliases` — and the cancellation importer already resolves
--    its `Productor` values through it (`ASSIGNMENT_MAPPING_TABLE` in
--    src/features/cancellations/import/loader.ts). This function reuses it rather than
--    creating a third mapping system, which design 12 forbids.
--
--    `public.renewal_normalize_assignment_label` is the comparison, and it is deliberately
--    the *renewal* definition rather than the cancellation importer's stricter
--    `normalizeProducerLabel`: it folds punctuation as well as whitespace, so it matches a
--    superset of what either side matched before, and one definition is the point.
--
--    A `(Deleted)` suffix resolves to nobody without consulting the mapping at all, which
--    is the order Requirement 9.7 of the cancellations spec already states it in.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_resolve_producer(
  p_label text,
  p_domain text default null)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_normalized text;
  v_profile_id uuid;
begin
  if p_label is null or btrim(p_label) = '' then return null; end if;
  -- A deleted label names nobody, whatever the mapping says.
  if p_label ~* '\(deleted\)\s*$' then return null; end if;

  v_normalized := public.renewal_normalize_assignment_label(p_label);
  if v_normalized is null or v_normalized = '' then return null; end if;

  -- The stored mapping first.
  select agent.profile_id
    into v_profile_id
    from public.renewal_assignment_aliases alias
    join public.policy_followup_eligible_agents(p_domain) agent on agent.profile_id = alias.profile_id
   where alias.normalized_label = v_normalized
   limit 1;

  if v_profile_id is not null then return v_profile_id; end if;

  -- Then the employee's own names, in the display_name > username > initials precedence the
  -- renewal importer already applies.
  select agent.profile_id
    into v_profile_id
    from public.policy_followup_eligible_agents(p_domain) agent
   where v_normalized in (
           public.renewal_normalize_assignment_label(agent.display_name),
           public.renewal_normalize_assignment_label(agent.username),
           public.renewal_normalize_assignment_label(agent.initials))
   order by case
     when public.renewal_normalize_assignment_label(agent.display_name) = v_normalized then 0
     when public.renewal_normalize_assignment_label(agent.username) = v_normalized then 1
     else 2
   end, agent.display_name
   limit 1;

  return v_profile_id;
end;
$fn$;

comment on function public.policy_followup_resolve_producer(text, text) is
  'The employee an imported producer label names, or null. Reuses public.renewal_assignment_aliases — the agency''s one mapping — then falls back to the employee''s own display name, username, or initials. A (Deleted) suffix resolves to nobody. Requirement 3.3 step 4.';

grant execute on function public.policy_followup_resolve_producer(text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. DOMAIN MIRRORING (Requirement 3.2, design 4.3)
--
--    `renewal_records.assigned_to` and `cancellation_cases.assigned_to` stay for
--    compatibility — every existing list, drawer, filter, and RLS policy reads them — so a
--    shared-owner decision has to reach them. Requirement 10.3 is the visible consequence:
--    one policy shows one owner in both domains.
--
--    Two rules the mirror obeys:
--
--      * Only *open* renewals and *active* cases are updated. Design 4.3 says not to
--        rewrite closed history, and a renewed policy's owner is a historical fact.
--      * A domain record whose own `assignment_source` is `manager` is not overwritten
--        unless the shared decision is itself a manager decision. The legacy
--        `renewal_assign` and `assignCancellationCase` paths still exist and still stamp
--        `manager`; Requirement 13.1 protects that from an import, and this is where.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_sync_domain_owner(
  p_carrier_key text,
  p_policy_number_normalized text,
  p_profile_id uuid,
  p_assignment_source text,
  p_actor_profile_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_manager_decision boolean := p_assignment_source = 'manager';
  v_renewal_source text;
  v_case_source text;
  v_renewals integer := 0;
  v_cases integer := 0;
  v_record record;
begin
  if p_carrier_key is null or p_policy_number_normalized is null then
    return jsonb_build_object('renewals_updated', 0, 'cancellations_updated', 0);
  end if;

  -- `renewal_records.assignment_source` accepts the Policy Follow-up vocabulary after
  -- v1.13.1; `migration` and `existing_owner` both mean "the shared owner already knew".
  v_renewal_source := case p_assignment_source
    when 'manager' then 'manager'
    when 'producer_mapping' then 'producer_mapping'
    when 'weighted_auto' then 'weighted_auto'
    else 'shared_owner'
  end;

  -- `cancellation_cases.assignment_source` accepts only ('import','manager','claim'), and
  -- widening it is not this spec's business, so every non-manager decision maps to `import`.
  v_case_source := case when v_manager_decision then 'manager' else 'import' end;

  for v_record in
    update public.renewal_records record
       set assigned_to = p_profile_id,
           assignment_source = v_renewal_source,
           assigned_at = case
             when record.assigned_to is distinct from p_profile_id then now()
             else record.assigned_at
           end,
           status = case
             when record.status::text = 'imported' and p_profile_id is not null
               then 'assigned'::public.renewal_status
             else record.status
           end,
           updated_at = now()
     where record.carrier_key = p_carrier_key
       and record.policy_number_normalized = p_policy_number_normalized
       and record.status::text = any(public.policy_followup_open_renewal_statuses())
       and record.assigned_to is distinct from p_profile_id
       and (v_manager_decision or coalesce(record.assignment_source, '') <> 'manager')
    returning record.id, record.assigned_to
  loop
    v_renewals := v_renewals + 1;
    insert into public.renewal_events(record_id, actor_id, event_type, detail)
    values (v_record.id, p_actor_profile_id, 'policy_owner_synchronized',
            jsonb_build_object(
              'carrier_key', p_carrier_key,
              'policy_number_normalized', p_policy_number_normalized,
              'assigned_to', p_profile_id,
              'assignment_source', v_renewal_source));
  end loop;

  for v_record in
    update public.cancellation_cases kase
       set assigned_to = p_profile_id,
           assignment_source = case when p_profile_id is null then null else v_case_source end,
           updated_at = now()
     where kase.carrier_key = p_carrier_key
       and kase.policy_number_normalized = p_policy_number_normalized
       and kase.case_status = any(public.policy_followup_active_case_statuses())
       and kase.assigned_to is distinct from p_profile_id
       and (v_manager_decision or coalesce(kase.assignment_source, '') <> 'manager')
    returning kase.id, kase.assigned_to
  loop
    v_cases := v_cases + 1;
    insert into public.cancellation_events(case_id, actor_id, event_type, detail)
    values (v_record.id, p_actor_profile_id, 'assignment',
            jsonb_build_object(
              'source', 'policy_followup_shared_owner',
              'carrier_key', p_carrier_key,
              'policy_number_normalized', p_policy_number_normalized,
              'assigned_to', p_profile_id,
              'assignment_source', v_case_source));
  end loop;

  return jsonb_build_object('renewals_updated', v_renewals, 'cancellations_updated', v_cases);
end;
$fn$;

comment on function public.policy_followup_sync_domain_owner(text, text, uuid, text, uuid) is
  'Mirrors a shared-owner decision onto the open renewals and active cancellations of that policy, writing a domain audit event for each. Never rewrites closed history, and never overrides a domain record whose own assignment_source is manager unless the shared decision is itself a manager decision. Requirements 3.2, 10.3, 13.1.';

revoke execute on function public.policy_followup_sync_domain_owner(text, text, uuid, text, uuid)
  from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. THE PRECEDENCE (Requirement 3.3)
--
--    One function, six steps, in order, under a lock. Returns what it decided and why
--    without raising, so an importer can record the outcome per row and carry on
--    (Requirement 11.2).
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_resolve_owner(
  p_domain text,
  p_record_id uuid,
  p_business_date date default null,
  p_allow_balancing boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_business_date date := coalesce(p_business_date, (now() at time zone 'America/New_York')::date);
  v_actor uuid := auth.uid();
  v_carrier_key text;
  v_policy text;
  v_domain_owner uuid;
  v_domain_source text;
  v_producer_label text;
  v_reliable boolean;
  v_owner public.policy_followup_policy_owners;
  v_existing_owner_id uuid;
  v_chosen uuid;
  v_source text;
  v_reason text;
  v_score integer;
  v_previous uuid;
  v_event_type text;
begin
  if p_domain not in ('renewal', 'cancellation') then
    raise exception 'policy_followup_resolve_owner needs a domain of renewal or cancellation (got %)',
                    coalesce(p_domain, 'null')
      using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
  end if;

  -- ── Read the record's identity, current owner, and reliability.
  if p_domain = 'renewal' then
    select record.carrier_key,
           record.policy_number_normalized,
           record.assigned_to,
           record.assignment_source,
           coalesce(record.producer_label, record.assigned_import_label, record.producer_name),
           coalesce(record.source_review_required, false) = false
      into v_carrier_key, v_policy, v_domain_owner, v_domain_source, v_producer_label, v_reliable
      from public.renewal_records record
     where record.id = p_record_id
       and record.status::text = any(public.policy_followup_open_renewal_statuses());
  else
    select kase.carrier_key,
           kase.policy_number_normalized,
           kase.assigned_to,
           kase.assignment_source,
           kase.producer_label,
           kase.case_status <> 'Import Review Required'
      into v_carrier_key, v_policy, v_domain_owner, v_domain_source, v_producer_label, v_reliable
      from public.cancellation_cases kase
     where kase.id = p_record_id
       and kase.case_status = any(public.policy_followup_active_case_statuses());
  end if;

  if not found then
    -- Not an error: a closed record is simply not assignable, and an importer that reaches
    -- one should record that and move on.
    return jsonb_build_object(
      'carrier_key', null, 'policy_number_normalized', null,
      'assigned_to', null, 'assignment_source', null, 'assignment_locked', false,
      'reason', 'record_not_assignable', 'workload_score', null, 'conflict', false);
  end if;

  -- ── Step 6 arrives early when there is no identity to own. Design 4.2: without a
  --    carrier there is no (carrier, policy) pair, and inventing an ownership link from the
  --    policy number alone would tie two carriers' policies together.
  if v_carrier_key is null or v_policy is null then
    return jsonb_build_object(
      'carrier_key', v_carrier_key, 'policy_number_normalized', v_policy,
      'assigned_to', v_domain_owner, 'assignment_source', v_domain_source,
      'assignment_locked', false,
      'reason', 'manager_review_no_identity', 'workload_score', null, 'conflict', false);
  end if;

  -- ── Serialize every decision about this one policy. Requirement 4.3: two simultaneous
  --    imports must not select the same lowest-workload employee from stale state. The
  --    advisory lock is transaction-scoped and released with the transaction.
  perform pg_advisory_xact_lock(hashtext('policy_followup_owner:' || v_carrier_key || '|' || v_policy));

  select * into v_owner
    from public.policy_followup_policy_owners
   where carrier_key = v_carrier_key
     and policy_number_normalized = v_policy
   for update;

  v_existing_owner_id := v_owner.id;
  v_previous := v_owner.assigned_to;

  -- ── Step 1: a manager lock is preserved, always (Requirement 3.3.1, 3.5).
  if v_existing_owner_id is not null and v_owner.assignment_locked then
    perform public.policy_followup_sync_domain_owner(
      v_carrier_key, v_policy, v_owner.assigned_to, 'manager', v_actor);
    return jsonb_build_object(
      'carrier_key', v_carrier_key, 'policy_number_normalized', v_policy,
      'assigned_to', v_owner.assigned_to, 'assignment_source', v_owner.assignment_source,
      'assignment_locked', true,
      'reason', 'manager_locked', 'workload_score', null, 'conflict', false);
  end if;

  -- ── An unresolved bootstrap conflict is not something balancing may settle (design 4.4).
  if v_existing_owner_id is not null and v_owner.conflict then
    return jsonb_build_object(
      'carrier_key', v_carrier_key, 'policy_number_normalized', v_policy,
      'assigned_to', null, 'assignment_source', v_owner.assignment_source,
      'assignment_locked', false,
      'reason', 'ownership_conflict', 'workload_score', null, 'conflict', true);
  end if;

  -- ── Step 2: the existing shared owner is preserved across reimports and both domains.
  if v_existing_owner_id is not null and v_owner.assigned_to is not null then
    perform public.policy_followup_sync_domain_owner(
      v_carrier_key, v_policy, v_owner.assigned_to, v_owner.assignment_source, v_actor);
    return jsonb_build_object(
      'carrier_key', v_carrier_key, 'policy_number_normalized', v_policy,
      'assigned_to', v_owner.assigned_to, 'assignment_source', v_owner.assignment_source,
      'assignment_locked', false,
      'reason', 'existing_owner', 'workload_score', null, 'conflict', false);
  end if;

  -- ── Step 3: bootstrap the shared owner from a valid current domain assignment rather
  --    than reassigning it (Requirement 3.3.3). This is the migration path for every
  --    policy that had an owner before the shared table existed.
  if v_domain_owner is not null then
    v_chosen := v_domain_owner;
    v_source := case when v_existing_owner_id is null then 'migration' else 'existing_owner' end;
    v_reason := 'domain_owner_bootstrap';
    v_event_type := 'bootstrap';
  else
    -- ── Step 4: the imported producer label (Requirement 3.3.4).
    v_chosen := public.policy_followup_resolve_producer(v_producer_label, p_domain);
    if v_chosen is not null then
      v_source := 'producer_mapping';
      v_reason := 'producer_mapping';
      v_event_type := 'producer_assignment';
    elsif p_allow_balancing and v_reliable then
      -- ── Step 5: weighted workload balancing, for an unowned *reliable* record only
      --    (Requirement 3.3.5). The score is computed here, inside the transaction holding
      --    the lock, so it cannot be stale.
      select workload.profile_id, workload.workload_score
        into v_chosen, v_score
        from public.policy_followup_workload_rows(v_business_date) workload
        left join public.policy_followup_policy_owners owner
               on owner.assigned_to = workload.profile_id
        where workload.auto_assignment_enabled
          and workload.assignment_mode <> 'manual_only'
          and ((p_domain = 'renewal' and workload.renewals_enabled)
               or (p_domain = 'cancellation' and workload.cancellations_enabled))
        group by workload.profile_id, workload.workload_score
        -- Requirement 4.3's deterministic tie break: lowest score, then the oldest last
        -- automatic assignment — an employee who has never had one sorts first — then the
        -- profile id, which makes the order total.
        order by workload.workload_score asc,
                 max(owner.last_auto_assigned_at) asc nulls first,
                 workload.profile_id asc
        limit 1;

      if v_chosen is not null then
        v_source := 'weighted_auto';
        v_reason := 'weighted_auto';
        v_event_type := 'auto_assignment';
      end if;
    end if;
  end if;

  -- ── Step 6: manager review. The record stays visible and unowned (Requirement 3.3.6).
  if v_chosen is null then
    if v_existing_owner_id is null then
      -- Record the unowned policy so the manager surface can list it and so the next
      -- import finds a row to lock rather than racing to create one.
      insert into public.policy_followup_policy_owners
        (carrier_key, policy_number_normalized, assignment_source)
      values (v_carrier_key, v_policy, 'migration')
      on conflict (carrier_key, policy_number_normalized) do nothing;
    end if;

    return jsonb_build_object(
      'carrier_key', v_carrier_key, 'policy_number_normalized', v_policy,
      'assigned_to', null, 'assignment_source', null, 'assignment_locked', false,
      'reason', case
        when not v_reliable then 'manager_review_unreliable_record'
        when v_producer_label is not null then 'manager_review_unmatched_producer'
        else 'manager_review_no_eligible_employee'
      end,
      'workload_score', null, 'conflict', false);
  end if;

  -- ── Write the decision.
  insert into public.policy_followup_policy_owners
    (carrier_key, policy_number_normalized, assigned_to, assignment_source,
     assigned_by, assigned_at, last_auto_assigned_at)
  values (v_carrier_key, v_policy, v_chosen, v_source, v_actor, now(),
          case when v_source = 'weighted_auto' then now() end)
  on conflict (carrier_key, policy_number_normalized) do update
    set assigned_to = excluded.assigned_to,
        assignment_source = excluded.assignment_source,
        assigned_by = excluded.assigned_by,
        assigned_at = excluded.assigned_at,
        last_auto_assigned_at = coalesce(excluded.last_auto_assigned_at,
                                         public.policy_followup_policy_owners.last_auto_assigned_at);

  insert into public.policy_followup_assignment_events
    (carrier_key, policy_number_normalized, domain, source_record_id, event_type,
     previous_profile_id, next_profile_id, actor_profile_id, detail)
  values (v_carrier_key, v_policy, p_domain, p_record_id, v_event_type,
          v_previous, v_chosen, v_actor,
          jsonb_build_object(
            'reason', v_reason,
            'assignment_source', v_source,
            'producer_label', v_producer_label,
            'workload_score', v_score,
            'business_date', v_business_date));

  perform public.policy_followup_sync_domain_owner(v_carrier_key, v_policy, v_chosen, v_source, v_actor);

  return jsonb_build_object(
    'carrier_key', v_carrier_key, 'policy_number_normalized', v_policy,
    'assigned_to', v_chosen, 'assignment_source', v_source, 'assignment_locked', false,
    'reason', v_reason, 'workload_score', v_score, 'conflict', false);
end;
$fn$;

comment on function public.policy_followup_resolve_owner(text, uuid, date, boolean) is
  'The Requirement 3.3 precedence for one domain record, under a per-policy advisory lock and a row lock: manager lock, existing shared owner, existing domain owner, producer mapping, weighted balancing, manager review. Returns what it decided and why without raising, so an importer records the outcome per row and carries on. Requirements 3.3, 4.3, 4.5.';

revoke execute on function public.policy_followup_resolve_owner(text, uuid, date, boolean)
  from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. THE PUBLIC ENTRY POINTS
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_auto_assign(
  p_domain text,
  p_record_id uuid,
  p_business_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public.policy_followup_is_manager() then
    raise exception 'Manager access is required to run Policy Follow-up assignment.'
      using errcode = 'insufficient_privilege',
            detail = 'Requirement 14.2. Automatic assignment runs from the manager import path.',
            hint = 'Nothing was written.';
  end if;

  return public.policy_followup_resolve_owner(p_domain, p_record_id, p_business_date, true);
end;
$fn$;

comment on function public.policy_followup_auto_assign(text, uuid, date) is
  'Manager-gated single-record assignment following the Requirement 3.3 precedence. An agent cannot invoke it to assign an arbitrary profile: the choice is the engine''s, and the gate is Manager_Role. Requirements 3.3, 14.2.';

grant execute on function public.policy_followup_auto_assign(text, uuid, date) to authenticated;

-- ── Manager assignment (Requirement 3.5)
create or replace function public.policy_followup_assign_policy(
  p_carrier_key text,
  p_policy_number_normalized text,
  p_profile_id uuid,
  p_manager_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
  v_previous uuid;
  v_sync jsonb;
begin
  if not public.policy_followup_is_manager() then
    raise exception 'Manager access is required to assign a policy.'
      using errcode = 'insufficient_privilege', hint = 'Nothing was written.';
  end if;

  if p_carrier_key is null or p_policy_number_normalized is null then
    raise exception 'policy_followup_assign_policy needs a carrier key and a normalized policy number'
      using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
  end if;

  if p_profile_id is null then
    raise exception 'policy_followup_assign_policy needs the employee who will own the policy'
      using errcode = 'invalid_parameter_value',
            detail = 'To release an ownership decision use policy_followup_unlock_policy_owner.',
            hint = 'Nothing was written.';
  end if;

  -- The target must be an active employee who may hold Policy Follow-up work. A manager may
  -- assign across the domain toggles — those govern *automatic* balancing (Requirement 3.4) —
  -- but not to an inactive or ineligible profile.
  if not exists (select 1 from public.policy_followup_eligible_agents(null)
                  where profile_id = p_profile_id) then
    raise exception 'That profile cannot hold Policy Follow-up work.'
      using errcode = 'invalid_parameter_value',
            detail = 'The employee must be active with a Policy Follow-up role.',
            hint = 'Nothing was written.';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('policy_followup_owner:' || p_carrier_key || '|' || p_policy_number_normalized));

  select assigned_to into v_previous
    from public.policy_followup_policy_owners
   where carrier_key = p_carrier_key
     and policy_number_normalized = p_policy_number_normalized
   for update;

  -- A manager decision clears any conflict: choosing is exactly how design 4.4 says a
  -- conflict is resolved, and it locks the result against future automatic reassignment
  -- (Requirement 3.5).
  insert into public.policy_followup_policy_owners
    (carrier_key, policy_number_normalized, assigned_to, assignment_source,
     assignment_locked, assigned_by, assigned_at, manager_note, conflict, conflict_detail)
  values (p_carrier_key, p_policy_number_normalized, p_profile_id, 'manager',
          true, v_actor, now(), nullif(btrim(coalesce(p_manager_note, '')), ''), false, null)
  on conflict (carrier_key, policy_number_normalized) do update
    set assigned_to = excluded.assigned_to,
        assignment_source = 'manager',
        assignment_locked = true,
        assigned_by = excluded.assigned_by,
        assigned_at = excluded.assigned_at,
        manager_note = coalesce(excluded.manager_note,
                                public.policy_followup_policy_owners.manager_note),
        conflict = false,
        conflict_detail = null;

  insert into public.policy_followup_assignment_events
    (carrier_key, policy_number_normalized, event_type,
     previous_profile_id, next_profile_id, actor_profile_id, detail)
  values (p_carrier_key, p_policy_number_normalized, 'manager_assignment',
          v_previous, p_profile_id, v_actor,
          jsonb_build_object('manager_note', nullif(btrim(coalesce(p_manager_note, '')), ''),
                             'locked', true));

  v_sync := public.policy_followup_sync_domain_owner(
    p_carrier_key, p_policy_number_normalized, p_profile_id, 'manager', v_actor);

  return jsonb_build_object(
    'carrier_key', p_carrier_key,
    'policy_number_normalized', p_policy_number_normalized,
    'assigned_to', p_profile_id,
    'assignment_source', 'manager',
    'assignment_locked', true,
    'reason', 'manager_assignment',
    'previous_profile_id', v_previous,
    'renewals_updated', v_sync -> 'renewals_updated',
    'cancellations_updated', v_sync -> 'cancellations_updated');
end;
$fn$;

comment on function public.policy_followup_assign_policy(text, text, uuid, text) is
  'Manager assignment or reassignment of one policy. Updates the shared owner and every open renewal and active cancellation for that policy, writes the shared and both domain audit trails, resolves any bootstrap conflict, and locks the result against future automatic reassignment. Requirements 3.5, 10.3, 13.2.';

grant execute on function public.policy_followup_assign_policy(text, text, uuid, text) to authenticated;

-- ── Explicit unlock (Requirement 3.5, 3.9 of tasks)
create or replace function public.policy_followup_unlock_policy_owner(
  p_carrier_key text,
  p_policy_number_normalized text,
  p_clear_owner boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
  v_previous uuid;
  v_owner public.policy_followup_policy_owners;
begin
  if not public.policy_followup_is_manager() then
    raise exception 'Manager access is required to unlock a policy owner.'
      using errcode = 'insufficient_privilege', hint = 'Nothing was written.';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('policy_followup_owner:' || p_carrier_key || '|' || p_policy_number_normalized));

  select * into v_owner
    from public.policy_followup_policy_owners
   where carrier_key = p_carrier_key
     and policy_number_normalized = p_policy_number_normalized
   for update;

  if not found then
    raise exception 'No shared owner is recorded for that policy.'
      using errcode = 'no_data_found', hint = 'Nothing was written.';
  end if;

  v_previous := v_owner.assigned_to;

  -- Unlocking releases the protection. It does *not* by itself reassign: Requirement 3.3
  -- step 2 then preserves the same owner on the next import, which is the point — a manager
  -- unlocks to allow future automatic reassignment, not to trigger one now. Clearing the
  -- owner as well is a second, explicit choice.
  update public.policy_followup_policy_owners
     set assignment_locked = false,
         assigned_to = case when p_clear_owner then null else assigned_to end,
         assignment_source = case
           when p_clear_owner then 'migration'
           -- A previously locked manager decision is now just an existing owner.
           when assignment_source = 'manager' then 'existing_owner'
           else assignment_source
         end
   where id = v_owner.id;

  insert into public.policy_followup_assignment_events
    (carrier_key, policy_number_normalized, event_type,
     previous_profile_id, next_profile_id, actor_profile_id, detail)
  values (p_carrier_key, p_policy_number_normalized, 'unlock',
          v_previous, case when p_clear_owner then null else v_previous end, v_actor,
          jsonb_build_object('cleared_owner', p_clear_owner));

  if p_clear_owner then
    perform public.policy_followup_sync_domain_owner(
      p_carrier_key, p_policy_number_normalized, null, 'manager', v_actor);
  end if;

  return jsonb_build_object(
    'carrier_key', p_carrier_key,
    'policy_number_normalized', p_policy_number_normalized,
    'assigned_to', case when p_clear_owner then null else v_previous end,
    'assignment_locked', false,
    'cleared_owner', p_clear_owner,
    'reason', 'unlock');
end;
$fn$;

comment on function public.policy_followup_unlock_policy_owner(text, text, boolean) is
  'Releases the manager protection on one policy so future imports may reassign it. Does not reassign by itself; p_clear_owner additionally removes the owner. Requirement 3.5.';

grant execute on function public.policy_followup_unlock_policy_owner(text, text, boolean) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. POST-CONDITIONS
--
--    The boundary assertions below are the same numbers
--    src/features/policy-follow-up/__tests__/workload.test.ts pins, so a change to the
--    weights or to either scoring ladder that is not made on both sides fails here or there.
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_missing text;
  v_day date := date '2026-02-10';
  v_points integer;
begin
  select string_agg(f.name, ', ' order by f.name) into v_missing
    from (values ('policy_followup_requote_started'), ('policy_followup_renewal_points'),
                 ('policy_followup_cancellation_points'), ('policy_followup_workload_rows'),
                 ('policy_followup_agent_workload'), ('policy_followup_resolve_producer'),
                 ('policy_followup_sync_domain_owner'), ('policy_followup_resolve_owner'),
                 ('policy_followup_auto_assign'), ('policy_followup_assign_policy'),
                 ('policy_followup_unlock_policy_owner')) as f(name)
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f.name);
  if v_missing is not null then
    raise exception 'v1.13.3 did not create: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── Renewal bands, at every boundary (Requirement 4.2).
  if public.policy_followup_renewal_points(true, v_day + 1, true, v_day, v_day) <> 0 then
    raise exception 'a closed renewal must score zero' using hint = 'Rolling back.';
  end if;
  if public.policy_followup_renewal_points(false, v_day + 31, false, null, v_day) <> 1 then
    raise exception 'renewal beyond 30 days must score 1' using hint = 'Rolling back.';
  end if;
  if public.policy_followup_renewal_points(false, v_day + 30, false, null, v_day) <> 2
     or public.policy_followup_renewal_points(false, v_day + 15, false, null, v_day) <> 3
     or public.policy_followup_renewal_points(false, v_day + 7, false, null, v_day) <> 4
     or public.policy_followup_renewal_points(false, v_day + 3, false, null, v_day) <> 5
     or public.policy_followup_renewal_points(false, v_day, false, null, v_day) <> 5 then
    raise exception 'the renewal date bands do not match Requirement 4.2' using hint = 'Rolling back.';
  end if;
  -- A slipped renewal date scores the tightest band, not the loosest.
  if public.policy_followup_renewal_points(false, v_day - 5, false, null, v_day) <> 5 then
    raise exception 'a past renewal date must score the tightest band' using hint = 'Rolling back.';
  end if;
  -- Non-renewal is a floor, not an addend: 7, not 12.
  if public.policy_followup_renewal_points(false, v_day + 1, true, null, v_day) <> 7 then
    raise exception 'carrier non-renewal must be a floor rather than an addend'
      using hint = 'Rolling back.';
  end if;
  if public.policy_followup_renewal_points(false, v_day + 90, false, v_day - 1, v_day) <> 6 then
    raise exception 'an overdue renewal follow-up must add 5' using hint = 'Rolling back.';
  end if;
  if public.policy_followup_renewal_points(false, v_day + 90, false, v_day + 3, v_day) <> 1 then
    raise exception 'a future renewal follow-up must add nothing' using hint = 'Rolling back.';
  end if;

  -- ── Cancellation bands, at every boundary (Requirement 4.2).
  if public.policy_followup_cancellation_points(true, v_day, true, true, v_day, v_day) <> 0 then
    raise exception 'a resolved cancellation must score zero' using hint = 'Rolling back.';
  end if;
  if public.policy_followup_cancellation_points(false, v_day + 16, false, false, null, v_day) <> 2
     or public.policy_followup_cancellation_points(false, v_day + 15, false, false, null, v_day) <> 3
     or public.policy_followup_cancellation_points(false, v_day + 10, false, false, null, v_day) <> 4
     or public.policy_followup_cancellation_points(false, v_day + 5, false, false, null, v_day) <> 6
     or public.policy_followup_cancellation_points(false, v_day + 1, false, false, null, v_day) <> 10
     or public.policy_followup_cancellation_points(false, v_day, false, false, null, v_day) <> 10 then
    raise exception 'the cancellation date bands do not match Requirement 4.2'
      using hint = 'Rolling back.';
  end if;
  if public.policy_followup_cancellation_points(false, v_day - 3, false, false, null, v_day) <> 10 then
    raise exception 'a past cancellation date must score the highest band' using hint = 'Rolling back.';
  end if;
  if public.policy_followup_cancellation_points(false, v_day + 40, true, false, null, v_day) <> 7 then
    raise exception 'payment verification must be a floor of 7' using hint = 'Rolling back.';
  end if;
  if public.policy_followup_cancellation_points(false, v_day + 40, false, true, null, v_day) <> 6 then
    raise exception 'manual communication must add 4' using hint = 'Rolling back.';
  end if;
  if public.policy_followup_cancellation_points(false, v_day, false, true, v_day, v_day) <> 19 then
    raise exception 'both cancellation modifiers must add on top of the band'
      using hint = 'Rolling back.';
  end if;

  -- ── Requirement 4.1's own example: forty urgent cancellations outweigh seventy distant
  --    renewals, which is the whole reason the model is not a row count.
  if 40 * public.policy_followup_cancellation_points(false, v_day + 5, false, false, null, v_day)
     <= 70 * public.policy_followup_renewal_points(false, v_day + 30, false, null, v_day) then
    raise exception 'the weight model does not rate urgent cancellations above distant renewals'
      using detail = 'Requirement 4.1.', hint = 'Rolling back.';
  end if;

  -- ── The internal functions are not reachable by a client role.
  if has_function_privilege('authenticated',
       'public.policy_followup_workload_rows(date)', 'execute') then
    raise exception 'policy_followup_workload_rows must not be executable by authenticated'
      using detail = 'Requirement 4.4.', hint = 'Rolling back.';
  end if;
  if has_function_privilege('authenticated',
       'public.policy_followup_resolve_owner(text, uuid, date, boolean)', 'execute') then
    raise exception 'policy_followup_resolve_owner must not be executable by authenticated'
      using detail = 'Requirement 14.2.', hint = 'Rolling back.';
  end if;
  if has_function_privilege('authenticated',
       'public.policy_followup_sync_domain_owner(text, text, uuid, text, uuid)', 'execute') then
    raise exception 'policy_followup_sync_domain_owner must not be executable by authenticated'
      using detail = 'Requirement 14.2.', hint = 'Rolling back.';
  end if;

  -- ── A deleted producer label resolves to nobody, without consulting the mapping.
  if public.policy_followup_resolve_producer('Somebody (Deleted)') is not null then
    raise exception 'a (Deleted) producer label must resolve to nobody' using hint = 'Rolling back.';
  end if;
  if public.policy_followup_resolve_producer(null) is not null
     or public.policy_followup_resolve_producer('   ') is not null then
    raise exception 'an absent producer label must resolve to nobody' using hint = 'Rolling back.';
  end if;

  raise notice 'v1.13.3 applied: the assignment engine is in place and its weights match Requirement 4.2.';
end;
$post$;
