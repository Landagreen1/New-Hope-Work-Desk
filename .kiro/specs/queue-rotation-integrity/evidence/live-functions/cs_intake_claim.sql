CREATE OR REPLACE FUNCTION public.cs_intake_claim(p_submission_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.cs_intake_submissions%rowtype;
  v_role text;
begin
  v_role := public.nhwd_role();

  -- Agents and sales_supervisors can claim intakes from the queue
  if v_role not in ('agent', 'manager', 'sales_supervisor') then
    raise exception 'Sales Agent or Manager access required to claim intakes.';
  end if;

  select * into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then raise exception 'Intake not found.'; end if;
  if v_row.status::text <> 'submitted' then
    raise exception 'This intake is no longer available to claim.';
  end if;

  update public.cs_intake_submissions
  set status = 'claimed',
      claimed_by = auth.uid(),
      claimed_at = now(),
      updated_at = now()
  where id = p_submission_id
    and status::text = 'submitted';

  if not found then
    raise exception 'Another agent claimed this intake first.';
  end if;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (p_submission_id, auth.uid(), 'claimed', jsonb_build_object('role', v_role));
end;
$function$

