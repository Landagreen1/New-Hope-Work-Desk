-- Add optional p_assigned_to parameter to cs_intake_submit_commercial
-- so the intake form can specify who the card should be assigned to.

CREATE OR REPLACE FUNCTION public.cs_intake_submit_commercial(
  p_submission_id uuid,
  p_assigned_to uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.cs_intake_submissions%rowtype;
  v_card_id uuid;
  v_business_name text;
  v_coverage_type text;
  v_description text;
  v_assigned_to uuid;
  v_next_position integer;
  v_caller_role text;
  v_checklist_id uuid;
BEGIN
  SELECT * INTO v_row
  FROM public.cs_intake_submissions
  WHERE id = p_submission_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Intake not found.'; END IF;

  -- Allow creator or manager/super_admin to submit
  v_caller_role := public.nhwd_role();
  IF v_row.created_by <> auth.uid() AND v_caller_role NOT IN ('manager', 'super_admin') THEN
    RAISE EXCEPTION 'You cannot submit this intake.';
  END IF;

  IF v_row.status::text NOT IN ('draft', 'returned') THEN
    RAISE EXCEPTION 'Only Draft or Returned intakes can be submitted.';
  END IF;

  -- Must be a commercial-routed LOB
  IF v_row.line_of_business::text NOT IN ('homeowners', 'trucking', 'commercial_gl') THEN
    RAISE EXCEPTION 'This function only handles homeowners, trucking, and commercial GL intakes.';
  END IF;

  -- Basic validation (name + phone required for all)
  IF nullif(trim(v_row.insured_first_name), '') IS NULL
     OR nullif(trim(v_row.insured_last_name), '') IS NULL
     OR nullif(trim(v_row.insured_phone_primary), '') IS NULL THEN
    RAISE EXCEPTION 'Insured name and phone are required.';
  END IF;

  -- LOB-specific validation
  IF v_row.line_of_business::text = 'trucking' THEN
    IF nullif(trim(v_row.business_name), '') IS NULL THEN RAISE EXCEPTION 'Business name is required for Trucking.'; END IF;
    IF nullif(trim(v_row.dot_number), '') IS NULL THEN RAISE EXCEPTION 'DOT number is required for Trucking.'; END IF;
  END IF;

  IF v_row.line_of_business::text = 'commercial_gl' THEN
    IF nullif(trim(v_row.business_name), '') IS NULL THEN RAISE EXCEPTION 'Business name is required for Commercial GL.'; END IF;
  END IF;

  IF v_row.line_of_business::text = 'homeowners' THEN
    IF nullif(trim(v_row.property_address_street), '') IS NULL THEN
      RAISE EXCEPTION 'Property address is required for Homeowners.';
    END IF;
  END IF;

  -- Determine business_name for the card
  v_business_name := coalesce(
    nullif(trim(v_row.business_name), ''),
    trim(v_row.insured_first_name || ' ' || v_row.insured_last_name)
  );

  -- Map LOB to coverage_type
  v_coverage_type := CASE v_row.line_of_business::text
    WHEN 'trucking' THEN 'trucking'
    WHEN 'commercial_gl' THEN 'gl'
    WHEN 'homeowners' THEN 'homeowners'
  END;

  -- Build description from all intake data
  v_description := '';

  -- Customer section
  v_description := v_description || E'── Customer ──────────────────────\n';
  v_description := v_description || 'Name: ' || trim(v_row.insured_first_name || ' ' || v_row.insured_last_name) || E'\n';
  IF v_row.insured_dob IS NOT NULL THEN
    v_description := v_description || 'DOB: ' || to_char(v_row.insured_dob, 'MM/DD/YYYY') || E'\n';
  END IF;
  IF v_row.insured_phone_primary IS NOT NULL THEN
    v_description := v_description || 'Phone: ' || v_row.insured_phone_primary || E'\n';
  END IF;
  IF v_row.insured_phone_alt IS NOT NULL THEN
    v_description := v_description || 'Alt Phone: ' || v_row.insured_phone_alt || E'\n';
  END IF;
  IF v_row.insured_email IS NOT NULL THEN
    v_description := v_description || 'Email: ' || v_row.insured_email || E'\n';
  END IF;
  IF v_row.addr_street IS NOT NULL THEN
    v_description := v_description || 'Address: ' || coalesce(v_row.addr_street, '') || ', ' || coalesce(v_row.addr_city, '') || ', ' || coalesce(v_row.addr_state, '') || ' ' || coalesce(v_row.addr_zip, '') || E'\n';
  END IF;

  -- Business section
  IF v_row.business_name IS NOT NULL OR v_row.ein IS NOT NULL OR v_row.dot_number IS NOT NULL THEN
    v_description := v_description || E'\n── Business ──────────────────────\n';
    IF v_row.business_name IS NOT NULL THEN v_description := v_description || 'Name: ' || v_row.business_name || E'\n'; END IF;
    IF v_row.ein IS NOT NULL THEN v_description := v_description || 'EIN: ' || v_row.ein || E'\n'; END IF;
    IF v_row.business_type IS NOT NULL THEN v_description := v_description || 'Type of work: ' || v_row.business_type || E'\n'; END IF;
    IF v_row.years_in_business IS NOT NULL THEN v_description := v_description || 'Years in business: ' || v_row.years_in_business || E'\n'; END IF;
    IF v_row.dot_number IS NOT NULL THEN v_description := v_description || 'DOT#: ' || v_row.dot_number || E'\n'; END IF;
    IF v_row.mc_number IS NOT NULL THEN v_description := v_description || 'MC#: ' || v_row.mc_number || E'\n'; END IF;
    IF v_row.mcs150_date IS NOT NULL THEN v_description := v_description || 'MCS-150: ' || to_char(v_row.mcs150_date, 'MM/DD/YYYY') || E'\n'; END IF;
    IF v_row.cargo_type IS NOT NULL THEN v_description := v_description || 'Cargo type: ' || v_row.cargo_type || E'\n'; END IF;
    IF v_row.power_unit_count IS NOT NULL THEN v_description := v_description || 'Power units: ' || v_row.power_unit_count || E'\n'; END IF;
    IF v_row.operating_radius_miles IS NOT NULL THEN v_description := v_description || 'Operating radius: ' || v_row.operating_radius_miles || ' mi' || E'\n'; END IF;
    IF v_row.states_of_operation IS NOT NULL THEN v_description := v_description || 'States: ' || v_row.states_of_operation || E'\n'; END IF;
    IF v_row.employee_count IS NOT NULL THEN v_description := v_description || 'Employees: ' || v_row.employee_count || E'\n'; END IF;
    IF v_row.annual_payroll IS NOT NULL THEN v_description := v_description || 'Annual payroll: $' || to_char(v_row.annual_payroll, 'FM999,999,999') || E'\n'; END IF;
  END IF;

  -- Homeowners property section
  IF v_row.line_of_business::text = 'homeowners' THEN
    v_description := v_description || E'\n── Property ──────────────────────\n';
    IF v_row.property_address_street IS NOT NULL THEN
      v_description := v_description || 'Address: ' || coalesce(v_row.property_address_street, '') || ', ' || coalesce(v_row.property_address_city, '') || ', ' || coalesce(v_row.property_address_state, '') || ' ' || coalesce(v_row.property_address_zip, '') || E'\n';
    END IF;
    IF v_row.dwelling_type IS NOT NULL THEN v_description := v_description || 'Dwelling: ' || v_row.dwelling_type || E'\n'; END IF;
    IF v_row.year_built IS NOT NULL THEN v_description := v_description || 'Year built: ' || v_row.year_built || E'\n'; END IF;
    IF v_row.square_footage IS NOT NULL THEN v_description := v_description || 'Sq ft: ' || v_row.square_footage || E'\n'; END IF;
    IF v_row.roof_type IS NOT NULL THEN v_description := v_description || 'Roof: ' || v_row.roof_type || E'\n'; END IF;
    IF v_row.roof_age IS NOT NULL THEN v_description := v_description || 'Roof age: ' || v_row.roof_age || ' yrs' || E'\n'; END IF;
    IF v_row.coverage_amount IS NOT NULL THEN v_description := v_description || 'Coverage amount: $' || to_char(v_row.coverage_amount, 'FM999,999,999') || E'\n'; END IF;
    IF v_row.prior_claims THEN
      v_description := v_description || 'Prior claims: Yes' || E'\n';
      IF v_row.prior_claims_detail IS NOT NULL THEN v_description := v_description || 'Details: ' || v_row.prior_claims_detail || E'\n'; END IF;
    END IF;
  END IF;

  -- Coverage types needed (commercial GL)
  IF v_row.coverage_types_needed IS NOT NULL AND array_length(v_row.coverage_types_needed, 1) > 0 THEN
    v_description := v_description || E'\n── Coverage Needed ───────────────\n';
    v_description := v_description || array_to_string(v_row.coverage_types_needed, ', ') || E'\n';
  END IF;

  -- Drivers
  IF EXISTS (SELECT 1 FROM public.cs_intake_drivers d WHERE d.submission_id = v_row.id) THEN
    v_description := v_description || E'\n── Drivers ───────────────────────\n';
    v_description := v_description || (
      SELECT string_agg(
        (d.position || '. ' || d.first_name || ' ' || d.last_name
         || coalesce(' — DL# ' || d.license_number, '')
         || coalesce(' (' || d.license_state || ')', '')
         || CASE WHEN d.dob IS NOT NULL THEN ' — DOB ' || to_char(d.dob, 'MM/DD/YYYY') ELSE '' END
        ), E'\n' ORDER BY d.position
      )
      FROM public.cs_intake_drivers d WHERE d.submission_id = v_row.id
    ) || E'\n';
  END IF;

  -- Vehicles
  IF EXISTS (SELECT 1 FROM public.cs_intake_vehicles v WHERE v.submission_id = v_row.id) THEN
    v_description := v_description || E'\n── Vehicles ──────────────────────\n';
    v_description := v_description || (
      SELECT string_agg(
        (v.position || '. ' || coalesce(v.year::text, '?') || ' ' || coalesce(v.make, '?') || ' ' || coalesce(v.model, '?')
         || CASE WHEN v.vin IS NOT NULL THEN ' — VIN: ' || v.vin ELSE '' END
        ), E'\n' ORDER BY v.position
      )
      FROM public.cs_intake_vehicles v WHERE v.submission_id = v_row.id
    ) || E'\n';
  END IF;

  -- Current policy
  IF v_row.current_carrier IS NOT NULL OR v_row.current_policy_number IS NOT NULL THEN
    v_description := v_description || E'\n── Current Policy ────────────────\n';
    IF v_row.current_carrier IS NOT NULL THEN v_description := v_description || 'Carrier: ' || v_row.current_carrier || E'\n'; END IF;
    IF v_row.current_policy_number IS NOT NULL THEN v_description := v_description || 'Policy#: ' || v_row.current_policy_number || E'\n'; END IF;
    IF v_row.current_premium IS NOT NULL THEN v_description := v_description || 'Premium: $' || to_char(v_row.current_premium, 'FM999,999') || '/yr' || E'\n'; END IF;
    IF v_row.current_expiration IS NOT NULL THEN v_description := v_description || 'Expires: ' || to_char(v_row.current_expiration, 'MM/DD/YYYY') || E'\n'; END IF;
  END IF;

  -- Notes
  IF nullif(trim(v_row.csr_notes), '') IS NOT NULL THEN
    v_description := v_description || E'\n── Notes ─────────────────────────\n';
    v_description := v_description || v_row.csr_notes || E'\n';
  END IF;

  -- Determine assigned_to: use explicit parameter if provided, otherwise auto-assign
  IF p_assigned_to IS NOT NULL THEN
    v_assigned_to := p_assigned_to;
  ELSIF v_caller_role IN ('agent', 'commercial') THEN
    v_assigned_to := auth.uid();
  ELSE
    -- Assign to a manager
    SELECT id INTO v_assigned_to
    FROM public.profiles
    WHERE role IN ('manager', 'super_admin') AND is_active = true
    ORDER BY role DESC, display_name
    LIMIT 1;

    IF v_assigned_to IS NULL THEN
      v_assigned_to := auth.uid();
    END IF;
  END IF;

  -- Get next position in quote_intake column
  SELECT coalesce(max(column_position), 0) + 1 INTO v_next_position
  FROM public.commercial_quotes
  WHERE board_column = 'quote_intake';

  -- Create the commercial card
  INSERT INTO public.commercial_quotes (
    business_name, description, board_column, column_position,
    risk_level, card_status, coverage_type, assigned_to, is_mirrored
  ) VALUES (
    v_business_name, v_description, 'quote_intake', v_next_position,
    'medium', 'in_progress', v_coverage_type, v_assigned_to, true
  ) RETURNING id INTO v_card_id;

  -- Record column history
  INSERT INTO public.commercial_quote_column_history (quote_id, from_column, to_column, moved_by)
  VALUES (v_card_id, NULL, 'quote_intake', auth.uid());

  -- Log activity
  INSERT INTO public.commercial_quote_activity_log (quote_id, actor_id, event_type, details)
  VALUES (v_card_id, auth.uid(), 'created', jsonb_build_object(
    'source', 'cs_intake',
    'intake_id', v_row.id,
    'line_of_business', v_row.line_of_business::text,
    'business_name', v_business_name,
    'assigned_to', v_assigned_to
  ));

  -- Create default checklist
  INSERT INTO public.commercial_quote_checklists (quote_id, title, position)
  VALUES (v_card_id, 'Required Documents', 0)
  RETURNING id INTO v_checklist_id;

  INSERT INTO public.commercial_quote_checklist_items (checklist_id, label, position) VALUES
    (v_checklist_id, 'Email', 1),
    (v_checklist_id, 'Recording', 2),
    (v_checklist_id, 'Form', 3);

  -- Update the intake submission
  UPDATE public.cs_intake_submissions
  SET status = 'converted',
      source_commercial_quote_id = v_card_id,
      submitted_at = coalesce(submitted_at, now()),
      converted_at = now(),
      updated_at = now()
  WHERE id = p_submission_id;

  -- Log intake event
  INSERT INTO public.cs_intake_events (submission_id, actor_id, event_type, detail)
  VALUES (p_submission_id, auth.uid(), 'converted_commercial', jsonb_build_object(
    'commercial_quote_id', v_card_id,
    'business_name', v_business_name,
    'assigned_to', v_assigned_to,
    'coverage_type', v_coverage_type
  ));

  RETURN v_card_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cs_intake_submit_commercial(uuid, uuid) TO authenticated;
