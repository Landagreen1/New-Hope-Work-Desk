-- v1.10.11 Deactivate Elvin Argueta (fired)
-- This migration:
-- 1. Sets is_active = false and disables all queue rotations
-- 2. Cancels all future scheduled shifts (preserves past records)
-- 3. Ensures rotation_state advances off him if he's the current agent
-- 4. Logs the action in audit_log

begin;

do $$
declare
  v_elvin_id uuid;
  v_admin_id uuid;
  v_rotation record;
begin
  -- Resolve Elvin's profile
  select id into v_elvin_id
  from public.profiles
  where display_name = 'Elvin Argueta' and is_active = true;

  if v_elvin_id is null then
    raise notice 'Elvin Argueta not found or already deactivated — skipping.';
    return;
  end if;

  -- Get a super_admin or manager to act as the audit actor
  select id into v_admin_id
  from public.profiles
  where role = 'super_admin' and is_active = true
  limit 1;
  if v_admin_id is null then
    select id into v_admin_id
    from public.profiles
    where role = 'manager' and is_active = true
    limit 1;
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 1. Deactivate profile and disable all queue participation
  -- ═══════════════════════════════════════════════════════════════════════════
  update public.profiles
  set
    is_active = false,
    availability = 'unavailable',
    whatsapp_active = false,
    ringcentral_active = false,
    workload_active = false,
    updated_at = now()
  where id = v_elvin_id;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 2. Cancel all FUTURE scheduled shifts (preserve historical records)
  -- ═══════════════════════════════════════════════════════════════════════════
  update public.employee_schedules
  set status = 'cancelled', notes = coalesce(notes || ' | ', '') || 'Cancelled: agent terminated'
  where profile_id = v_elvin_id
    and schedule_date >= current_date
    and status not in ('cancelled', 'completed');

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 3. Advance rotation if Elvin is currently assigned in any queue
  -- ═══════════════════════════════════════════════════════════════════════════
  for v_rotation in
    select kind from public.rotation_state where current_profile_id = v_elvin_id
  loop
    -- Use next_eligible_profile to find the successor
    update public.rotation_state
    set
      current_profile_id = public.next_eligible_profile(
        v_rotation.kind,
        (select
          case v_rotation.kind
            when 'whatsapp' then whatsapp_position
            when 'ringcentral' then ringcentral_position
            when 'workload' then workload_position
          end
        from public.profiles where id = v_elvin_id)
      ),
      version = version + 1,
      updated_at = now(),
      updated_by = v_admin_id
    where kind = v_rotation.kind;

    -- Record the auto-skip event
    insert into public.turn_events (rotation, action, actor_profile_id, previous_profile_id, next_profile_id, reason)
    values (
      v_rotation.kind,
      'auto_skip',
      v_admin_id,
      v_elvin_id,
      (select current_profile_id from public.rotation_state where kind = v_rotation.kind),
      'Agent terminated — auto-advanced rotation'
    );
  end loop;

  -- ═══════════════════════════════════════════════════════════════════════════
  -- 4. Audit log entry
  -- ═══════════════════════════════════════════════════════════════════════════
  insert into public.audit_log (actor_profile_id, action, entity_type, entity_id, reason)
  values (
    v_admin_id,
    'user_deactivated',
    'profile',
    v_elvin_id,
    'Agent terminated (fired) — removed from schedules and queue rotations'
  );

end $$;

commit;
