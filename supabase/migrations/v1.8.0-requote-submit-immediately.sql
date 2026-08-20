-- v1.8.0: Rework renewal_send_to_requote to submit the intake immediately
-- (status='submitted') and set renewal status='requote_sent' in one step.
-- Previously it left the intake as a 'draft' requiring manual submission.

create or replace function public.renewal_send_to_requote(p_record_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.renewal_records%rowtype;
  v_intake_id uuid;
  v_first text;
  v_last text;
  v_lob text;
begin
  select * into v_row from public.renewal_records where id = p_record_id for update;
  if not found then raise exception 'Renewal not found.'; end if;
  if public.nhwd_role() not in ('manager', 'super_admin') and v_row.assigned_to <> auth.uid() then
    raise exception 'This renewal is not assigned to you.';
  end if;
  if v_row.status::text in ('renewed', 'lost', 'cancelled') then
    raise exception 'Closed renewals cannot be sent to re-quote.';
  end if;
  if v_row.requote_intake_id is not null then return v_row.requote_intake_id; end if;

  v_first := split_part(trim(v_row.customer_name), ' ', 1);
  v_last := nullif(trim(substr(trim(v_row.customer_name), length(v_first) + 1)), '');
  v_lob := case when lower(coalesce(v_row.line_of_business, '')) ~ '(commercial|truck|motor carrier)' then 'commercial_auto' else 'auto' end;

  if v_lob = 'commercial_auto' then
    insert into public.cs_intake_submissions (
      status, priority, line_of_business, quote_kind, source_renewal_id,
      created_by, dealer_id, salesperson_id,
      insured_first_name, insured_last_name, insured_phone_primary, insured_email,
      current_carrier, current_policy_number, current_premium, current_expiration,
      business_name, desired_coverage, csr_notes,
      submitted_at
    ) values (
      'submitted', 'high', 'commercial_auto', 'requote', p_record_id,
      auth.uid(), v_row.dealer_id, v_row.salesperson_id,
      coalesce(v_first, ''), coalesce(v_last, ''), v_row.customer_phone, v_row.customer_email,
      v_row.carrier, v_row.policy_number, coalesce(v_row.premium_renewal, v_row.premium_current), v_row.renewal_date,
      v_row.customer_name, 'unsure',
      'Requote from Renewal Management. Policy ' || coalesce(v_row.policy_number, '?') || ' · ' || coalesce(v_row.carrier, 'Unknown carrier') || '. Complete DOB, address, drivers, vehicles, coverage request, and any missing commercial details.',
      now()
    ) returning id into v_intake_id;
  else
    insert into public.cs_intake_submissions (
      status, priority, line_of_business, quote_kind, source_renewal_id,
      created_by, dealer_id, salesperson_id,
      insured_first_name, insured_last_name, insured_phone_primary, insured_email,
      current_carrier, current_policy_number, current_premium, current_expiration,
      desired_coverage, csr_notes,
      submitted_at
    ) values (
      'submitted', 'high', 'auto', 'requote', p_record_id,
      auth.uid(), v_row.dealer_id, v_row.salesperson_id,
      coalesce(v_first, ''), coalesce(v_last, ''), v_row.customer_phone, v_row.customer_email,
      v_row.carrier, v_row.policy_number, coalesce(v_row.premium_renewal, v_row.premium_current), v_row.renewal_date,
      'unsure',
      'Requote from Renewal Management. Policy ' || coalesce(v_row.policy_number, '?') || ' · ' || coalesce(v_row.carrier, 'Unknown carrier') || '. Complete DOB, address, drivers, vehicles, and coverage request.',
      now()
    ) returning id into v_intake_id;
  end if;

  -- Mark the renewal as requote_sent immediately
  update public.renewal_records
  set requote_intake_id = v_intake_id,
      status = 'requote_sent',
      requote_sent_at = now(),
      updated_at = now()
  where id = p_record_id;

  -- Log event on the intake
  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (v_intake_id, auth.uid(), 'created', jsonb_build_object(
    'line_of_business', v_lob,
    'source', 'renewal_requote'
  ));

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (v_intake_id, auth.uid(), 'submitted', jsonb_build_object(
    'line_of_business', v_lob,
    'quote_kind', 'requote',
    'priority', 'high'
  ));

  -- Log event on the renewal
  insert into public.renewal_events (record_id, actor_id, event_type, detail)
  values (p_record_id, auth.uid(), 'requote_intake_submitted', jsonb_build_object('intake_id', v_intake_id));

  -- Notify sales agents
  insert into public.user_notifications (
    recipient_profile_id, notification_type, title, message, entity_type, entity_id
  )
  select p.id, 'assignment', 'Requote from Renewals',
         coalesce(nullif(v_row.customer_name, ''), 'Customer') ||
         ' — ' || coalesce(v_row.carrier, 'Unknown') || ' policy requote is ready in the Sales Intake Queue.',
         'cs_intake', v_intake_id
  from public.profiles p
  where p.is_active and p.role::text = 'agent';

  return v_intake_id;
end;
$$;
