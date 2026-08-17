-- New Hope Work Desk v1.15.4 — The customer's actual information, on the quote.
--
-- Opening a quote in Quote Center showed the identity fields and the lifecycle, but
-- not what the customer actually told us. Which information exists depends entirely
-- on where the quote came from, and the answer was different for each origin:
--
--   Customer Service intake  every answer on the form — drivers, vehicles,
--                            coverage, current carrier, LOB-specific details,
--                            CSR notes
--   WhatsApp / RingCentral   the dealer it came from, the dealership salesperson,
--                            the customer name, and the note the agent typed
--   Manual / manager-created the same, plus how it was assigned
--
-- So this returns one record with both halves and lets the screen render whichever
-- is present, rather than pretending every quote has the same shape.
--
-- Read-only. No table is written and no existing object is replaced.
--
-- ── Why the quote half needs its own query ───────────────────────────────────
--
-- quote_center_quote_stage unifies the three lifecycle tables but deliberately
-- carries only what a result card needs. `note` and `change_type` are not on it,
-- and for a WhatsApp or manual quote the note is often the only place the customer's
-- situation was written down. work_items has both, pending_pricing_quotes has the
-- note, quote_outcomes has neither — so the note is coalesced across whichever
-- table still holds the row.

begin;

create or replace function public.quote_center_journey_record(
  p_intake_id uuid default null,
  p_work_item_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_intake jsonb := null;
  v_quote  jsonb := null;
begin
  if not public.can_view_quote_center() then
    raise exception 'Quote Center is not available for your role.';
  end if;

  if p_intake_id is null and p_work_item_id is null then
    raise exception 'A journey identifier is required.';
  end if;

  -- ── The intake half ───────────────────────────────────────────────────────
  -- Every column, plus the child rows. Gated on can_read_cs_intake as well as the
  -- Quote Center check, so a per-record restriction still applies to the record
  -- rather than only to the screen.
  if p_intake_id is not null and public.can_read_cs_intake(p_intake_id) then
    select
      to_jsonb(s)
      || jsonb_build_object(
           'dealer_name', d.name,
           'dealer_notes', d.notes,
           'salesperson_name', dsp.name,
           'started_by_name', starter.display_name,
           'completed_by_name', completer.display_name,
           'drivers', (
             select coalesce(jsonb_agg(to_jsonb(dr) order by dr.position), '[]'::jsonb)
             from public.cs_intake_drivers dr
             where dr.submission_id = s.id
           ),
           'vehicles', (
             select coalesce(jsonb_agg(to_jsonb(v) order by v.position), '[]'::jsonb)
             from public.cs_intake_vehicles v
             where v.submission_id = s.id
           ),
           'owners', (
             select coalesce(jsonb_agg(to_jsonb(o) order by o.position), '[]'::jsonb)
             from public.cs_intake_owners o
             where o.submission_id = s.id
           )
         )
    into v_intake
    from public.cs_intake_submissions s
    left join public.dealers d on d.id = s.dealer_id
    left join public.dealer_salespeople dsp on dsp.id = s.salesperson_id
    left join public.profiles starter on starter.id = s.created_by
    left join public.profiles completer on completer.id = s.completed_by
    where s.id = p_intake_id;
  end if;

  -- ── The quote half ────────────────────────────────────────────────────────
  -- What a WhatsApp, RingCentral or manually created quote actually recorded.
  if p_work_item_id is not null then
    select jsonb_build_object(
             'source_work_item_id', st.source_work_item_id,
             'customer_name', st.customer_name,
             'work_type', st.work_type,
             'assignment_method', st.assignment_method,
             'received_through', st.received_through,
             'dealer_name', d.name,
             'dealer_notes', d.notes,
             'salesperson_name', dsp.name,
             'assigned_agent_name', assignee.display_name,
             'original_owner_name', owner_p.display_name,
             'quote_created_at', st.quote_created_at,
             'assigned_at', st.assigned_at,
             'accepted_at', st.accepted_at,
             'price_sent_at', st.price_sent_at,
             'finalized_at', st.finalized_at,
             'decision', st.decision,
             'not_sold_reason', st.not_sold_reason,
             -- The free-text note. For a WhatsApp or manual quote this is usually
             -- where the customer's situation was written down, so it matters more
             -- here than anywhere else.
             'note', coalesce(
               (select w.note from public.work_items w where w.id = st.source_work_item_id),
               (select p.note from public.pending_pricing_quotes p
                 where p.source_work_item_id = st.source_work_item_id)
             ),
             'change_type', (
               select w.change_type from public.work_items w where w.id = st.source_work_item_id
             ),
             -- Timing for a quote taken off a rotation timer, when there is any.
             'take_event', (
               select to_jsonb(qte)
               from public.quote_take_events qte
               where qte.source_work_item_id = st.source_work_item_id
               order by qte.taken_at desc
               limit 1
             )
           )
    into v_quote
    from public.quote_center_quote_stage st
    left join public.dealers d on d.id = st.dealer_id
    left join public.dealer_salespeople dsp on dsp.id = st.salesperson_id
    left join public.profiles assignee on assignee.id = st.assigned_profile_id
    left join public.profiles owner_p on owner_p.id = st.original_owner_profile_id
    where st.source_work_item_id = p_work_item_id;

    -- The quote row is gone (a manager deleted it) but the conversion payload
    -- survives on the immutable event, so the customer's information is not lost
    -- with the row.
    if v_quote is null then
      select we.details
      into v_quote
      from public.work_item_events we
      where we.source_work_item_id = p_work_item_id
        and we.event_type = 'created_from_cs_intake'
      order by we.created_at desc
      limit 1;
    end if;
  end if;

  return jsonb_build_object('intake', v_intake, 'quote', v_quote);
end;
$fn$;

revoke execute on function public.quote_center_journey_record(uuid, uuid) from public, anon;
grant execute on function public.quote_center_journey_record(uuid, uuid) to authenticated;

comment on function public.quote_center_journey_record(uuid, uuid) is
  'The customer information behind one journey. Returns {intake, quote}: the full intake form with its drivers, vehicles and owners when the journey started as a Customer Service intake, and the dealer, salesperson, customer name and agent note when it came from WhatsApp, RingCentral or a manual entry. Either half may be null.';

commit;
