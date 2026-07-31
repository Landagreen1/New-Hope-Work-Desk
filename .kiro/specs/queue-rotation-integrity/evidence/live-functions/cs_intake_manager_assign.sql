CREATE OR REPLACE FUNCTION public.cs_intake_manager_assign(p_submission_id uuid, p_agent_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_creator uuid;
  v_name text;
begin
  -- Managers, super_admins, sales_supervisors, and CS supervisors can assign
  if not public.can_manage_sales() and not public.can_manage_customer_service() then
    raise exception 'Manager or Supervisor access required.';
  end if;

  -- Target must be an active user who handles sales quotes
  if not exists (
    select 1 from public.profiles
    where id = p_agent_id
      and is_active
      and role::text in ('agent', 'sales_supervisor')
  ) then
    raise exception 'Choose an active Sales Agent or Sales Supervisor.';
  end if;

  update public.cs_intake_submissions
  set status = 'claimed',
      claimed_by = p_agent_id,
      claimed_at = now(),
      intake_channel = 'manual',
      updated_at = now()
  where id = p_submission_id
    and status::text = 'submitted'
  returning created_by into v_creator;

  if not found then
    raise exception 'This intake is no longer available for assignment.';
  end if;

  select display_name into v_name from public.profiles where id = p_agent_id;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (
    p_submission_id,
    auth.uid(),
    'manager_assigned',
    jsonb_build_object(
      'assigned_to', p_agent_id,
      'assigned_name', v_name,
      'intake_channel', 'manual'
    )
  );

  insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (p_agent_id, 'assignment', 'Quote intake assigned to you', 'A Manager assigned a Customer Service intake. Review it and create the quote.', 'cs_intake', p_submission_id);

  insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (v_creator, 'assignment', 'Your intake was assigned', 'Sales Agent ' || coalesce(v_name, '') || ' received your quote intake.', 'cs_intake', p_submission_id);
end;
$function$

