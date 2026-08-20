-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.18.5 — Fix specialty_update_carrier_market patch whitelist
--
-- Problem: quote_number, installment_count, and installment_amount were added to
--          specialty_carrier_markets (via add-quote-number.sql and v1.18.2) but
--          the v_allowed array in the update RPC was never expanded. The frontend
--          sends these fields and the server responds:
--            "Field quote_number cannot be changed on a carrier market."
--
-- Fix:     Add the three fields to v_allowed and handle them in the UPDATE SET.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_update_carrier_market(
  p_market_id uuid,
  p_patch jsonb,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_market public.specialty_carrier_markets;
  v_carrier text;
  v_key text;
  v_status text;
  v_allowed text[] := array[
    'status', 'handled_by', 'follow_up_date', 'premium', 'down_payment',
    'payment_terms', 'deductible', 'coverage_notes', 'decline_reason',
    'info_requested', 'notes', 'submitted_at',
    'installment_count', 'installment_amount', 'quote_number'
  ];
begin
  select * into v_market from public.specialty_carrier_markets where id = p_market_id for update;
  if not found then raise exception 'That carrier market could not be found.'; end if;

  if not public.specialty_can_edit_opportunity(v_market.opportunity_id) then
    raise exception 'You cannot change carriers on this specialty quote.' using errcode = '42501';
  end if;

  if p_expected_version is not null and v_market.version <> p_expected_version then
    raise exception 'This carrier was updated by another employee while you were working on it. Review the latest information before saving.'
      using errcode = '40001';
  end if;

  for v_key in select jsonb_object_keys(p_patch) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'Field % cannot be changed on a carrier market.', v_key;
    end if;
  end loop;

  select name into v_carrier from public.specialty_carriers where id = v_market.carrier_id;
  v_status := coalesce(nullif(p_patch ->> 'status', ''), v_market.status);

  if v_status not in ('not_started', 'preparing', 'submitted', 'waiting', 'more_info_needed',
                      'quote_received', 'declined', 'not_competitive', 'withdrawn') then
    raise exception 'Unknown carrier status %.', v_status;
  end if;

  -- Validation before the write, so the message names the missing thing rather than
  -- surfacing a constraint violation.
  if v_status = 'quote_received'
     and coalesce(nullif(p_patch ->> 'premium', '')::numeric, v_market.premium) is null then
    raise exception 'Enter the quoted premium when a carrier quote is received.';
  end if;
  if v_status = 'declined'
     and nullif(btrim(coalesce(p_patch ->> 'decline_reason', v_market.decline_reason, '')), '') is null then
    raise exception 'Record why % declined.', coalesce(v_carrier, 'the carrier');
  end if;
  if v_status = 'more_info_needed'
     and nullif(btrim(coalesce(p_patch ->> 'info_requested', v_market.info_requested, '')), '') is null then
    raise exception 'Record what % is asking for.', coalesce(v_carrier, 'the carrier');
  end if;

  update public.specialty_carrier_markets m
     set status = v_status,
         handled_by = case when p_patch ? 'handled_by'
                           then nullif(p_patch ->> 'handled_by', '')::uuid else m.handled_by end,
         follow_up_date = case when p_patch ? 'follow_up_date'
                               then nullif(p_patch ->> 'follow_up_date', '')::date else m.follow_up_date end,
         premium = case when p_patch ? 'premium'
                        then nullif(p_patch ->> 'premium', '')::numeric else m.premium end,
         down_payment = case when p_patch ? 'down_payment'
                             then nullif(p_patch ->> 'down_payment', '')::numeric else m.down_payment end,
         payment_terms = case when p_patch ? 'payment_terms'
                              then nullif(btrim(p_patch ->> 'payment_terms'), '') else m.payment_terms end,
         deductible = case when p_patch ? 'deductible'
                           then nullif(btrim(p_patch ->> 'deductible'), '') else m.deductible end,
         coverage_notes = case when p_patch ? 'coverage_notes'
                               then nullif(btrim(p_patch ->> 'coverage_notes'), '') else m.coverage_notes end,
         decline_reason = case when p_patch ? 'decline_reason'
                               then nullif(btrim(p_patch ->> 'decline_reason'), '') else m.decline_reason end,
         info_requested = case when p_patch ? 'info_requested'
                               then nullif(btrim(p_patch ->> 'info_requested'), '') else m.info_requested end,
         notes = case when p_patch ? 'notes'
                      then nullif(btrim(p_patch ->> 'notes'), '') else m.notes end,
         installment_count = case when p_patch ? 'installment_count'
                                  then (p_patch ->> 'installment_count')::integer else m.installment_count end,
         installment_amount = case when p_patch ? 'installment_amount'
                                   then (p_patch ->> 'installment_amount')::numeric else m.installment_amount end,
         quote_number = case when p_patch ? 'quote_number'
                             then nullif(btrim(p_patch ->> 'quote_number'), '') else m.quote_number end,
         -- Submission and quote receipt are stamped the first time the status says
         -- so, and the employee who did it is recorded. Later edits do not move the
         -- date, because the pipeline timings depend on when it actually happened.
         submitted_at = case
           when p_patch ? 'submitted_at' then nullif(p_patch ->> 'submitted_at', '')::timestamptz
           when v_status in ('submitted', 'waiting', 'more_info_needed', 'quote_received',
                             'declined', 'not_competitive')
             then coalesce(m.submitted_at, now())
           else m.submitted_at end,
         submitted_by = case
           when m.submitted_by is null
                and v_status in ('submitted', 'waiting', 'more_info_needed', 'quote_received',
                                 'declined', 'not_competitive')
             then auth.uid()
           else m.submitted_by end,
         quote_received_at = case
           when v_status = 'quote_received' then coalesce(m.quote_received_at, now())
           else m.quote_received_at end,
         quote_received_by = case
           when v_status = 'quote_received' and m.quote_received_by is null then auth.uid()
           else m.quote_received_by end,
         last_action_at = now(),
         last_action_by = auth.uid(),
         version = m.version + 1
   where m.id = p_market_id;

  perform public.specialty_log(v_market.opportunity_id,
    case v_status
      when 'submitted' then 'carrier_submitted'
      when 'quote_received' then 'carrier_quote_received'
      when 'declined' then 'carrier_declined'
      when 'withdrawn' then 'carrier_withdrawn'
      else 'carrier_updated' end,
    jsonb_build_object(
      'carrier_id', v_market.carrier_id,
      'carrier_name', v_carrier,
      'from_status', v_market.status,
      'to_status', v_status,
      'premium', case when p_patch ? 'premium' then nullif(p_patch ->> 'premium', '') else null end,
      'patch_fields', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(p_patch) k)
    ),
    p_market_id);

  -- The opportunity's stage follows what the markets are actually doing.
  if v_market.submitted_at is null and v_status in ('submitted', 'waiting', 'more_info_needed',
                                                    'quote_received', 'declined', 'not_competitive') then
    perform set_config('specialty.privileged', 'on', true);
    update public.specialty_opportunities
       set first_submission_at = coalesce(first_submission_at, now())
     where id = v_market.opportunity_id;
    perform set_config('specialty.privileged', 'off', true);
    perform public.specialty_advance_stage(v_market.opportunity_id, 'marketing',
      array['new', 'information_needed', 'ready_to_market']);
  end if;

  if v_status = 'quote_received' then
    perform set_config('specialty.privileged', 'on', true);
    update public.specialty_opportunities
       set first_quote_at = coalesce(first_quote_at, now())
     where id = v_market.opportunity_id;
    perform set_config('specialty.privileged', 'off', true);
    perform public.specialty_advance_stage(v_market.opportunity_id, 'options_ready',
      array['new', 'information_needed', 'ready_to_market', 'marketing']);
  end if;

  update public.specialty_opportunities
     set last_activity_at = now() where id = v_market.opportunity_id;

  return jsonb_build_object('version', v_market.version + 1, 'status', v_status);
end;
$$;

comment on function public.specialty_update_carrier_market(uuid, jsonb, integer) is
  'Updates one carrier market. Any eligible team member may update any market on the team''s opportunity — Oscar records the Progressive premium Jason submitted — and the activity row names whoever actually acted. Advances the opportunity stage as a consequence of real marketing progress. Spec sections 40-44.';
