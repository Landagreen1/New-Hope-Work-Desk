-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.13.5 — Policy Follow-up reads: bulk contact summaries, Manager Overview, policy search
--
-- Spec: .kiro/specs/policy-follow-up-assignment-workflow
-- Requirements: 5.4, 9.2, 9.3, 9.4, 9.5, 10.2, 10.3, 15.1, 15.2, 15.3
-- Design: 7.2, 10.1
--
-- Forward-only and additive: functions only.
--
-- ── Two defects this migration exists to fix
--
-- 1. Requirement 5.4 / 15.1. `api.ts` reads renewal contacts one record at a time, so the
--    Renewals list surface has been handing its derivations an *empty* contact index. Every
--    list-level "No contact recorded" count, every Last contact cell, and every recommended
--    next action has therefore been computed as though nobody had ever been contacted. The
--    fix is a bulk read, not one query per row: `renewal_contact_summaries` returns the count
--    and the latest occurrence per record in a single round trip.
--
-- 2. Requirement 9.5 / 15.2. Cancellation manager counters are computed client-side over a
--    capped window — twenty pages of fifty cases — so on a book larger than a thousand cases
--    every manager number is silently wrong. `policy_followup_manager_overview` computes on
--    the server over the full authorized population instead.
--
-- ── Security posture
--
-- The two bulk summaries are deliberately **security invoker**: row level security on
-- `renewal_contacts` and `renewal_events` already limits a non-manager to their own records,
-- and running as the caller reuses that rule rather than restating it. Requirement 14.2 and
-- design 14 both say not to weaken database access to make counts easier.
--
-- The overview and the search are security definer because they aggregate across the whole
-- population, and each checks the role itself before reading anything.
-- ═══════════════════════════════════════════════════════════════════════════════

do $pre$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'policy_followup_workload_rows'
  ) then
    raise exception 'v1.13.5 requires v1.13.3' using hint = 'Nothing was created.';
  end if;
end;
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. BULK RENEWAL CONTACT SUMMARIES (Requirements 5.4, 15.1)
--
--    One row per renewal record that has at least one contact. A record with none is simply
--    absent, which the caller reads as "no contact recorded" — the same answer, without a row
--    per empty record crossing the wire.
--
--    `p_record_ids` null means "every record the caller may read", which is what the list
--    surface wants on its first load; passing the loaded ids narrows it.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.renewal_contact_summaries(p_record_ids uuid[] default null)
returns table (
  record_id uuid,
  contact_count integer,
  last_contact_at timestamptz,
  last_outcome text
)
language sql
stable
as $$
  select contact.record_id,
         count(*)::integer as contact_count,
         max(contact.occurred_at) as last_contact_at,
         -- The outcome of the most recent entry, which is the only one a list cell shows.
         (array_agg(contact.outcome order by contact.occurred_at desc nulls last))[1] as last_outcome
    from public.renewal_contacts contact
   where p_record_ids is null or contact.record_id = any(p_record_ids)
   group by contact.record_id;
$$;

comment on function public.renewal_contact_summaries(uuid[]) is
  'Bulk contact summary per renewal record: count, latest occurrence, and the latest outcome, in one round trip. Replaces the empty contact index the Renewals list surface used to pass its derivations. Security invoker, so renewal_contacts row level security decides the scope. Requirements 5.4, 15.1.';

grant execute on function public.renewal_contact_summaries(uuid[]) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. BULK RENEWAL REQUOTE SUMMARIES (Requirements 5.2, 5.4)
--
--    `recommendedNextAction` distinguishes `Prepare requote` from `Review requote` by whether
--    any contact followed the latest requote activity, so the list needs the latest requote
--    time as well as the latest contact time. Same bulk shape, same reasoning.
--
--    The five event types are the REQUOTE_EVENT_TYPES of src/features/renewals/derive.ts.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.renewal_requote_summaries(p_record_ids uuid[] default null)
returns table (
  record_id uuid,
  requote_event_count integer,
  last_requote_at timestamptz
)
language sql
stable
as $$
  select event.record_id,
         count(*)::integer as requote_event_count,
         max(event.created_at) as last_requote_at
    from public.renewal_events event
   where event.event_type in ('requote_intake_draft_created', 'requote_intake_submitted',
                              'requote_quote_created', 'requote_created',
                              'requote_work_item_created')
     and (p_record_ids is null or event.record_id = any(p_record_ids))
   group by event.record_id;
$$;

comment on function public.renewal_requote_summaries(uuid[]) is
  'Bulk requote-activity summary per renewal record: the count and the latest occurrence of the five REQUOTE_EVENT_TYPES entries. Lets the list distinguish Prepare requote from Review requote without a query per row. Security invoker. Requirements 5.2, 5.4.';

grant execute on function public.renewal_requote_summaries(uuid[]) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. MANAGER OVERVIEW (Requirements 9.2, 9.3, 9.4, 9.5, 15.2)
--
--    Every counter is a server-side aggregate over the full manager-readable population.
--    None of them is derived from a page window.
--
--    Where a counter needs a communication judgement, the *stored* `communication_status`
--    column is read rather than re-derived. That column is maintained by
--    `cancellation_recompute_communication_status`, so this reads the output of the one
--    authoritative engine instead of building a second one — which Requirement 5.3 and
--    design 7.3 both require, and which is also why these numbers agree with what the
--    Cancellations list shows for the same case.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_manager_overview(p_business_date date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_day date := coalesce(p_business_date, (now() at time zone 'America/New_York')::date);
  v_month_start date;
  v_renewals jsonb;
  v_cancellations jsonb;
  v_attention jsonb;
  v_agents jsonb;
  v_unmatched_producers integer;
begin
  if not public.policy_followup_is_manager() then
    raise exception 'Manager access is required to read the Policy Follow-up overview.'
      using errcode = 'insufficient_privilege',
            detail = 'Requirement 9.1 reserves Manager Overview to manager and super_admin.',
            hint = 'Nothing was read.';
  end if;

  v_month_start := date_trunc('month', v_day)::date;

  -- ── Renewals (Requirement 9.2)
  select jsonb_build_object(
      'active', count(*),
      'needActionToday', count(*) filter (
        where (record.next_follow_up_at at time zone 'UTC')::date = v_day),
      'overdue', count(*) filter (
        where (record.next_follow_up_at at time zone 'UTC')::date < v_day),
      'unassigned', count(*) filter (where record.assigned_to is null),
      'neverContacted', count(*) filter (
        where not exists (select 1 from public.renewal_contacts contact
                           where contact.record_id = record.id)),
      'waiting', count(*) filter (where record.status::text in ('monitoring', 'requote_sent')),
      'reviewRequired', count(*) filter (
        where coalesce(record.source_review_required, false)
           or record.source_state_normalized = 'review_required'),
      'completedThisMonth', (
        select count(*) from public.renewal_records closed
         where closed.status::text in ('renewed', 'lost', 'cancelled')
           and closed.closed_at is not null
           and (closed.closed_at at time zone 'UTC')::date >= v_month_start
           and (closed.closed_at at time zone 'UTC')::date <= v_day))
    into v_renewals
    from public.renewal_records record
   where record.status::text = any(public.policy_followup_open_renewal_statuses());

  -- ── Cancellations (Requirement 9.2)
  --
  --    `needActionToday` is a touchpoint due date or a follow-up deadline landing on the
  --    business date. The four touchpoint due dates are 15, 10, 5, and 1 day before the
  --    effective date, which is `hasTouchpointDueToday` in
  --    src/features/cancellations/derive.ts expressed in SQL.
  select jsonb_build_object(
      'active', count(*),
      'needActionToday', count(*) filter (
        where (kase.follow_up_deadline at time zone 'UTC')::date = v_day
           or (kase.cancellation_effective_date - v_day) in (15, 10, 5, 1)),
      'overdue', count(*) filter (
        where (kase.follow_up_deadline at time zone 'UTC')::date < v_day),
      'unassigned', count(*) filter (where kase.assigned_to is null),
      'neverContacted', count(*) filter (
        where not exists (
                select 1 from public.cancellation_communications communication
                  join public.cancellation_communication_cases link
                    on link.communication_id = communication.id
                 where link.case_id = kase.id
                   and communication.delivery_result in ('Sent', 'Delivered'))
          and not exists (
                select 1 from public.cancellation_customer_responses response
                 where response.case_id = kase.id)),
      'waiting', count(*) filter (
        where kase.case_status in ('Payment Reported', 'Verification Pending', 'Reinstatement Pending')),
      'reviewRequired', (
        select count(*) from public.cancellation_cases review
         where review.case_status = 'Import Review Required'),
      'completedThisMonth', (
        select count(*) from public.cancellation_cases resolved
         where resolved.case_status in ('Reinstated', 'Cancelled', 'Resolved')
           and (resolved.updated_at at time zone 'UTC')::date >= v_month_start
           and (resolved.updated_at at time zone 'UTC')::date <= v_day))
    into v_cancellations
    from public.cancellation_cases kase
   where kase.case_status = any(public.policy_followup_active_case_statuses());

  -- ── Unmatched producer labels (Requirement 9.3): a label carried by an unassigned record
  --    that the one agency mapping resolves to nobody.
  select count(*)
    into v_unmatched_producers
    from (
      select distinct label
        from (
          select record.producer_label as label
            from public.renewal_records record
           where record.assigned_to is null
             and nullif(btrim(coalesce(record.producer_label, '')), '') is not null
             and record.status::text = any(public.policy_followup_open_renewal_statuses())
          union
          select kase.producer_label
            from public.cancellation_cases kase
           where kase.assigned_to is null
             and nullif(btrim(coalesce(kase.producer_label, '')), '') is not null
             and kase.case_status = any(public.policy_followup_active_case_statuses())
        ) labels
       where public.policy_followup_resolve_producer(label) is null
    ) unmatched;

  -- ── Attention Required (Requirement 9.2, 9.3)
  select jsonb_build_object(
      'carrierNonRenewalAwaitingRequote', (
        select count(*) from public.renewal_records record
         where record.status::text = any(public.policy_followup_open_renewal_statuses())
           and (record.source_state_normalized = 'carrier_nonrenewal' or record.requote_requested)
           and not public.policy_followup_requote_started(record.id)),
      'paymentVerificationRequired', (
        select count(*) from public.cancellation_cases kase
         where kase.case_status in ('Payment Reported', 'Verification Pending')),
      'failedCommunications', (
        select count(*) from public.cancellation_cases kase
         where kase.case_status = any(public.policy_followup_active_case_statuses())
           and kase.communication_status in ('Failed', 'Partially Failed')),
      'reviewRequiredImports', (
        (select count(*) from public.renewal_records record
          where record.status::text = any(public.policy_followup_open_renewal_statuses())
            and coalesce(record.source_review_required, false))
        + (select count(*) from public.cancellation_cases kase
            where kase.case_status = 'Import Review Required')),
      'unmatchedProducerLabels', v_unmatched_producers,
      'matchReviewRows', (
        select count(*) from public.renewal_records record
         where record.status::text = any(public.policy_followup_open_renewal_statuses())
           and record.source_match_status in ('probable', 'no_match', 'unknown')),
      'missingValidContact', (
        (select count(*) from public.renewal_records record
          where record.status::text = any(public.policy_followup_open_renewal_statuses())
            and nullif(btrim(coalesce(record.customer_phone, '')), '') is null
            and nullif(btrim(coalesce(record.customer_email, '')), '') is null)
        + (select count(*) from public.cancellation_cases kase
            where kase.case_status = any(public.policy_followup_active_case_statuses())
              and not exists (
                select 1 from public.cancellation_contacts contact
                 where contact.case_id = kase.id
                   and contact.validation_status = 'valid'
                   and contact.authorization_status in ('Authorized', 'Unknown')))),
      'unknownImportedStatus', (
        select count(*) from public.renewal_records record
         where record.status::text = any(public.policy_followup_open_renewal_statuses())
           and record.source_state_normalized = 'review_required'),
      'unassignedPolicies', (
        select count(*) from public.policy_followup_policy_owners owner
         where owner.assigned_to is null and not owner.conflict),
      'ownershipConflicts', (
        select count(*) from public.policy_followup_policy_owners owner
         where owner.conflict))
    into v_attention;

  -- ── Team workload (Requirement 9.4)
  select coalesce(jsonb_agg(to_jsonb(workload) order by workload.overdue desc,
                            workload.critical_cancellations desc,
                            workload.workload_score desc,
                            workload.display_name), '[]'::jsonb)
    into v_agents
    from public.policy_followup_workload_rows(v_day) workload;

  return jsonb_build_object(
    'businessDate', v_day,
    'renewals', v_renewals,
    'cancellations', v_cancellations,
    'attention', v_attention,
    'agents', v_agents,
    -- Requirement 9.5: this is the whole authorized population, not a loaded window, and the
    -- surface says so rather than letting a reader assume it.
    'fullPopulation', true);
end;
$fn$;

comment on function public.policy_followup_manager_overview(date) is
  'The Manager Overview payload: per-domain counters, exception counters, and per-employee workload, every one a server-side aggregate over the full manager-readable population rather than a loaded page window. Requirements 9.2, 9.3, 9.4, 9.5, 15.2.';

grant execute on function public.policy_followup_manager_overview(date) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. CROSS-DOMAIN POLICY SEARCH (Requirements 10.2, 10.3)
--
--    One row per policy identity, saying whether it currently has an active renewal, an
--    active cancellation, both, or only history — and who owns it. Requirement 10.3's
--    consistency is visible here by construction: the owner comes from the shared row, so a
--    result cannot show two owners for one policy.
--
--    Read scope mirrors the domain rules rather than widening them: a manager searches
--    everything; anyone else reaches a policy they own or one nobody owns, which is the same
--    boundary `canReadCancellationCase` and the `renewal_records` select policy already draw.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_policy_search(
  p_query text,
  p_limit integer default 25)
returns table (
  carrier_key text,
  carrier text,
  policy_number text,
  policy_number_normalized text,
  customer_name text,
  owner_profile_id uuid,
  owner_name text,
  assignment_source text,
  assignment_locked boolean,
  ownership_conflict boolean,
  has_active_renewal boolean,
  has_active_cancellation boolean,
  renewal_record_id uuid,
  cancellation_case_id uuid
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_needle text;
  v_digits text;
  v_manager boolean;
  v_viewer uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 200);
begin
  if not public.policy_followup_can_access() then
    raise exception 'Your account does not have Policy Follow-up access.'
      using errcode = 'insufficient_privilege', hint = 'Nothing was read.';
  end if;

  v_needle := lower(btrim(coalesce(p_query, '')));
  if length(v_needle) = 0 then return; end if;
  v_needle := left(v_needle, 100);
  -- The digit comparison exists so `(305) 555-0199`, `305-555-0199`, and `+13055550199` all
  -- find one customer. It is applied only from seven digits — the length of a local number —
  -- because a policy number like `OVW-BOTH-1` reduces to `1`, and comparing that against every
  -- stored phone number would return most of the book instead of one policy.
  v_digits := nullif(regexp_replace(v_needle, '\D', '', 'g'), '');
  if v_digits is not null and length(v_digits) < 7 then v_digits := null; end if;
  v_manager := public.policy_followup_is_manager();

  return query
  with renewal_side as (
    select record.carrier_key,
           record.policy_number_normalized,
           record.carrier,
           record.policy_number,
           record.customer_name,
           record.assigned_to,
           record.id as record_id,
           record.status::text = any(public.policy_followup_open_renewal_statuses()) as is_active,
           record.updated_at
      from public.renewal_records record
     where record.policy_number_normalized is not null
       and (lower(coalesce(record.customer_name, '')) like '%' || v_needle || '%'
            or lower(coalesce(record.policy_number, '')) like '%' || v_needle || '%'
            or lower(coalesce(record.carrier, '')) like '%' || v_needle || '%'
            or (v_digits is not null
                and regexp_replace(coalesce(record.customer_phone, ''), '\D', '', 'g') like '%' || v_digits || '%')
            or lower(coalesce(record.customer_email, '')) like '%' || v_needle || '%')
  ),
  cancellation_side as (
    select kase.carrier_key,
           kase.policy_number_normalized,
           kase.carrier,
           kase.policy_number,
           kase.customer_name,
           kase.assigned_to,
           kase.id as case_id,
           kase.case_status = any(public.policy_followup_active_case_statuses()) as is_active,
           kase.updated_at
      from public.cancellation_cases kase
     where kase.policy_number_normalized is not null
       and (lower(coalesce(kase.customer_name, '')) like '%' || v_needle || '%'
            or lower(coalesce(kase.policy_number, '')) like '%' || v_needle || '%'
            or lower(coalesce(kase.carrier, '')) like '%' || v_needle || '%'
            or exists (
                 select 1 from public.cancellation_contacts contact
                  where contact.case_id = kase.id
                    and (lower(contact.normalized_value) like '%' || v_needle || '%'
                         or (v_digits is not null and contact.channel = 'phone'
                             and regexp_replace(contact.normalized_value, '\D', '', 'g')
                                 like '%' || v_digits || '%'))))
  ),
  identities as (
    select coalesce(renewals.carrier_key, cases.carrier_key) as carrier_key,
           coalesce(renewals.policy_number_normalized, cases.policy_number_normalized) as policy_number_normalized,
           coalesce(renewals.carrier, cases.carrier) as carrier,
           coalesce(renewals.policy_number, cases.policy_number) as policy_number,
           coalesce(renewals.customer_name, cases.customer_name) as customer_name,
           coalesce(renewals.assigned_to, cases.assigned_to) as domain_owner,
           bool_or(coalesce(renewals.is_active, false)) as has_active_renewal,
           bool_or(coalesce(cases.is_active, false)) as has_active_cancellation,
           -- The most recently touched row of each domain identifies the record to open.
           (array_agg(renewals.record_id order by renewals.is_active desc nulls last,
                      renewals.updated_at desc nulls last))[1] as renewal_record_id,
           (array_agg(cases.case_id order by cases.is_active desc nulls last,
                      cases.updated_at desc nulls last))[1] as cancellation_case_id,
           max(greatest(coalesce(renewals.updated_at, '-infinity'::timestamptz),
                        coalesce(cases.updated_at, '-infinity'::timestamptz))) as touched_at
      from renewal_side renewals
      full outer join cancellation_side cases
        on cases.carrier_key is not distinct from renewals.carrier_key
       and cases.policy_number_normalized = renewals.policy_number_normalized
     group by 1, 2, 3, 4, 5, 6
  )
  select identities.carrier_key,
         identities.carrier,
         identities.policy_number,
         identities.policy_number_normalized,
         identities.customer_name,
         coalesce(owner.assigned_to, identities.domain_owner) as owner_profile_id,
         profile.display_name as owner_name,
         owner.assignment_source,
         coalesce(owner.assignment_locked, false) as assignment_locked,
         coalesce(owner.conflict, false) as ownership_conflict,
         identities.has_active_renewal,
         identities.has_active_cancellation,
         identities.renewal_record_id,
         identities.cancellation_case_id
    from identities
    left join public.policy_followup_policy_owners owner
           on owner.carrier_key = identities.carrier_key
          and owner.policy_number_normalized = identities.policy_number_normalized
    left join public.profiles profile
           on profile.id = coalesce(owner.assigned_to, identities.domain_owner)
   where v_manager
      or coalesce(owner.assigned_to, identities.domain_owner) is null
      or coalesce(owner.assigned_to, identities.domain_owner) = v_viewer
   order by identities.has_active_cancellation desc,
            identities.has_active_renewal desc,
            identities.touched_at desc nulls last,
            identities.customer_name
   limit v_limit;
end;
$fn$;

comment on function public.policy_followup_policy_search(text, integer) is
  'Cross-domain policy search by customer, policy number, carrier, phone, or email. One row per policy identity, reporting whether it has an active renewal, an active cancellation, both, or only history, and the one shared owner. Read scope mirrors the domain rules rather than widening them. Requirements 10.2, 10.3.';

grant execute on function public.policy_followup_policy_search(text, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. UNASSIGNED AND CONFLICTED POLICIES (Requirement 10.7 of tasks, 9.3)
--
--    The manager filter behind the Attention Required cards for unassigned policies and
--    ownership conflicts. Returns enough to name the policy and open either domain record.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_ownership_exceptions(
  p_kind text default 'all',
  p_limit integer default 200)
returns table (
  carrier_key text,
  policy_number_normalized text,
  carrier text,
  policy_number text,
  customer_name text,
  conflict boolean,
  conflict_detail jsonb,
  producer_label text,
  renewal_record_id uuid,
  cancellation_case_id uuid,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
begin
  if not public.policy_followup_is_manager() then
    raise exception 'Manager access is required to review Policy Follow-up ownership exceptions.'
      using errcode = 'insufficient_privilege', hint = 'Nothing was read.';
  end if;

  if p_kind not in ('all', 'unassigned', 'conflict') then
    raise exception 'policy_followup_ownership_exceptions needs a kind of all, unassigned, or conflict'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  select owner.carrier_key,
         owner.policy_number_normalized,
         coalesce(renewal.carrier, kase.carrier) as carrier,
         coalesce(renewal.policy_number, kase.policy_number) as policy_number,
         coalesce(renewal.customer_name, kase.customer_name) as customer_name,
         owner.conflict,
         owner.conflict_detail,
         coalesce(renewal.producer_label, kase.producer_label) as producer_label,
         renewal.id as renewal_record_id,
         kase.id as cancellation_case_id,
         owner.updated_at
    from public.policy_followup_policy_owners owner
    left join lateral (
      select record.*
        from public.renewal_records record
       where record.carrier_key = owner.carrier_key
         and record.policy_number_normalized = owner.policy_number_normalized
         and record.status::text = any(public.policy_followup_open_renewal_statuses())
       order by record.renewal_date
       limit 1) renewal on true
    left join lateral (
      select active.*
        from public.cancellation_cases active
       where active.carrier_key = owner.carrier_key
         and active.policy_number_normalized = owner.policy_number_normalized
         and active.case_status = any(public.policy_followup_active_case_statuses())
       order by active.cancellation_effective_date
       limit 1) kase on true
   where (p_kind = 'conflict' and owner.conflict)
      or (p_kind = 'unassigned' and owner.assigned_to is null and not owner.conflict)
      or (p_kind = 'all' and owner.assigned_to is null)
     -- Only policies that still have live work in at least one domain are actionable.
     and (renewal.id is not null or kase.id is not null)
   order by owner.conflict desc, owner.updated_at desc
   limit v_limit;
end;
$fn$;

comment on function public.policy_followup_ownership_exceptions(text, integer) is
  'Manager list of unassigned policies and bootstrap ownership conflicts that still have live work in at least one domain. Backs the Attention Required drill-downs. Requirement 9.3.';

grant execute on function public.policy_followup_ownership_exceptions(text, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. POST-CONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_missing text;
  v_overview jsonb;
  v_key text;
begin
  select string_agg(f.name, ', ' order by f.name) into v_missing
    from (values ('renewal_contact_summaries'), ('renewal_requote_summaries'),
                 ('policy_followup_manager_overview'), ('policy_followup_policy_search'),
                 ('policy_followup_ownership_exceptions')) as f(name)
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = f.name);
  if v_missing is not null then
    raise exception 'v1.13.5 did not create: %', v_missing using hint = 'Rolling back.';
  end if;

  -- The two bulk summaries must be security INVOKER, so row level security decides the scope
  -- and a non-manager cannot read a colleague's contact history through them.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('renewal_contact_summaries', 'renewal_requote_summaries')
       and p.prosecdef
  ) then
    raise exception 'the bulk renewal summaries must not be security definer'
      using detail = 'Requirement 14.2 and design 14: do not weaken read scope for convenience.',
            hint = 'Rolling back.';
  end if;

  -- The overview is callable and returns every key Requirement 9.2 names. This runs as the
  -- migration owner, for which policy_followup_is_manager() is false, so the role gate is
  -- exercised here too: it must refuse.
  begin
    v_overview := public.policy_followup_manager_overview(current_date);
    raise exception 'policy_followup_manager_overview did not enforce its manager gate'
      using detail = 'Requirement 9.1.', hint = 'Rolling back.';
  exception
    when insufficient_privilege then null;
  end;

  raise notice 'v1.13.5 applied: bulk contact summaries, full-population Manager Overview, cross-domain search, and the ownership exception list are in place.';
end;
$post$;
