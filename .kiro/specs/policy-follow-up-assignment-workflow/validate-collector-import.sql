-- ═══════════════════════════════════════════════════════════════════════════════
-- Validation harness for collector import (v1.13.6).
--
-- Not a migration. Imports a synthetic renewals collector payload and a synthetic
-- cancellations collector payload, **twice each**, with staff work recorded in between,
-- asserts the outcome, and discards everything.
--
-- What it proves:
--   * Requirement 2.4  a second import of the same file duplicates no policy, no case, no
--                      contact, no owner row, and no import-created event
--   * Requirement 13.1 source facts update; notes, contacts, the scheduled follow-up, the
--                      workflow status, and a manager's assignment all survive
--   * Requirement 2.5  a closed renewal stays closed, and is counted as preserved
--   * Requirement 1.1  the raw Spanish record type, carrier status, match result, file name,
--                      row number, collector warning, and whole source row are all retained
--   * Requirement 1.2  the normalized state is stored beside them
--   * Requirement 1.3  an unrecognized record type imports as review-required
--   * Requirement 8.4  a paid signal moves the case to Payment Reported, not to resolved
--   * Requirement 11.2 the import reports assignment by source, separately from row counts
--   * design 11.2      the collector column set owns both halves of the legacy pair
-- ═══════════════════════════════════════════════════════════════════════════════

do $validate$
declare
  v_manager uuid;
  v_agent_a uuid;
  v_agent_b uuid;
  v_day date := (now() at time zone 'America/New_York')::date;

  v_renewal_rows jsonb;
  v_cancellation_rows jsonb;
  v_mapping jsonb;
  v_first jsonb;
  v_second jsonb;
  v_run public.cancellation_import_runs;

  v_record public.renewal_records;
  v_case public.cancellation_cases;
  v_nonrenewal_id uuid;
  v_review_id uuid;
  v_closed_id uuid;
  v_owner_rows integer;
  v_contact_rows integer;

  -- Failures accumulate as one indented text block rather than as an array: `array || 'literal'`
  -- is ambiguous in plpgsql, and a harness that errors while reporting a failure hides it.
  v_failures text := '';
  v_note text;
begin
  select id into v_manager from public.profiles
   where is_active and role::text in ('manager', 'super_admin') order by id limit 1;
  select profile_id into v_agent_a from public.policy_followup_eligible_agents(null)
   order by profile_id limit 1;
  select profile_id into v_agent_b from public.policy_followup_eligible_agents(null)
   where profile_id <> v_agent_a order by profile_id limit 1;

  if v_manager is null or v_agent_a is null or v_agent_b is null then
    raise exception 'the collector harness needs a manager and two eligible employees';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_manager::text)::text, true);

  -- Nobody receives balanced work, so every assignment below is explained by the producer
  -- mapping or by manager review rather than by whatever the live book happens to weigh.
  insert into public.policy_followup_agent_settings
    (profile_id, auto_assignment_enabled, assignment_mode)
  select profile_id, false, 'manual_only' from public.policy_followup_eligible_agents(null)
  on conflict (profile_id) do update
    set auto_assignment_enabled = false, assignment_mode = 'manual_only';

  insert into public.renewal_assignment_aliases
    (import_label, normalized_label, profile_id, created_by)
  values ('COL PRODUCER ONE',
          public.renewal_normalize_assignment_label('COL PRODUCER ONE'),
          v_agent_a, v_manager)
  on conflict (normalized_label) do update set profile_id = excluded.profile_id;

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- RENEWALS COLLECTOR IMPORT
  --
  --   Row 1: an ordinary renewal with a mapped producer -> producer_mapping
  --   Row 2: `No renueva` with an unmapped producer     -> carrier_nonrenewal, manager review
  --   Row 3: an unrecognized record type                -> review_required
  -- ═══════════════════════════════════════════════════════════════════════════════
  v_renewal_rows := jsonb_build_array(
    jsonb_build_object(
      'row_number', 1,
      'policy_number', 'COL-R-0001', 'policy_number_normalized', 'COL-R-0001',
      'carrier', 'Progressive', 'carrier_key', 'PROGRESSIVE',
      'customer_name', 'Collector Alpha LLC', 'line_of_business', 'Commercial Auto',
      'hawksoft_client_id', 'CC1001',
      'customer_phone', '3055550101', 'customer_email', 'alpha@example.invalid',
      'renewal_date', (v_day + 40)::text, 'expiration_date', (v_day + 40)::text,
      'premium_current', 1700, 'premium_renewal', 1850,
      'producer_label', 'Col Producer One',
      'source_state_normalized', 'renewal',
      'source_record_type', 'Renovacion', 'source_status_raw', 'Renewal Offered',
      'source_match_status', 'exact', 'source_match_method', 'ClienteID',
      'source_match_status_raw', 'Exacto',
      'source_file_name', 'consolidado_renovaciones_probe.csv', 'source_row_number', 1,
      'source_warning', null,
      'source_review_required', false, 'source_communication_blocked', false,
      'source_payload', jsonb_build_object('Compania', 'Progressive', 'TipoRegistro', 'Renovacion')),
    jsonb_build_object(
      'row_number', 2,
      'policy_number', 'COL-R-0002', 'policy_number_normalized', 'COL-R-0002',
      'carrier', 'NatGen', 'carrier_key', 'NATIONALGENERAL',
      'customer_name', 'Collector Bravo Inc', 'line_of_business', 'Personal Auto',
      'customer_phone', '3055550102', 'customer_email', 'bravo@example.invalid',
      'renewal_date', (v_day + 3)::text,
      'premium_current', 910, 'premium_renewal', 980,
      'producer_label', 'COL PRODUCER NOBODY KNOWS',
      'source_state_normalized', 'carrier_nonrenewal',
      'source_record_type', 'No renueva', 'source_status_raw', 'Carrier will not offer renewal',
      'source_match_status', 'exact', 'source_match_method', 'Poliza',
      'source_match_status_raw', 'Exacto',
      'source_file_name', 'consolidado_renovaciones_probe.csv', 'source_row_number', 2,
      'source_warning', null,
      'source_review_required', false, 'source_communication_blocked', false,
      'source_payload', jsonb_build_object('Compania', 'NatGen', 'TipoRegistro', 'No renueva')),
    jsonb_build_object(
      'row_number', 3,
      'policy_number', 'COL-R-0003', 'policy_number_normalized', 'COL-R-0003',
      'carrier', 'Mercury', 'carrier_key', 'MERCURY',
      'customer_name', 'Collector Charlie Corp',
      'renewal_date', (v_day + 60)::text,
      'premium_renewal', 4200,
      'producer_label', null,
      'source_state_normalized', 'review_required',
      'source_record_type', 'Estado desconocido del carrier',
      'source_status_raw', 'Something the carrier printed',
      'source_match_status', 'probable', 'source_match_method', 'Nombre',
      'source_match_status_raw', 'Probable',
      'source_file_name', 'consolidado_renovaciones_probe.csv', 'source_row_number', 3,
      'source_warning', 'Tipo de registro no reconocido',
      'source_review_required', true, 'source_communication_blocked', true,
      'source_payload', jsonb_build_object('AvisosImportacion', 'Tipo de registro no reconocido')));

  v_first := public.renewal_import_collector_batch('consolidado_renovaciones_probe.csv', v_renewal_rows);

  if (v_first ->> 'rows_inserted')::integer <> 3 then
    v_failures := v_failures || E'\n  ' || format('renewal import inserted %s rather than 3',
                                                 v_first ->> 'rows_inserted');
  end if;
  if (v_first ->> 'rows_carrier_nonrenewal')::integer <> 1 then
    v_failures := v_failures || E'\n  ' || 'renewal import did not count the carrier non-renewal';
  end if;
  if (v_first ->> 'rows_review_required')::integer <> 1 then
    v_failures := v_failures || E'\n  ' || 'renewal import did not count the review-required row';
  end if;

  -- Requirement 11.2: assignment is reported by source, separately from the row counts.
  if (v_first -> 'assignment' ->> 'producer_mapping')::integer <> 1 then
    v_failures := v_failures || E'\n  ' || format(
      'renewal import reported %s producer-mapped assignments rather than 1',
      v_first -> 'assignment' ->> 'producer_mapping');
  end if;
  if (v_first -> 'assignment' ->> 'unassigned_review')::integer <> 2 then
    v_failures := v_failures || E'\n  ' || format(
      'renewal import reported %s rows left for manager review rather than 2',
      v_first -> 'assignment' ->> 'unassigned_review');
  end if;
  if not (v_first -> 'unmatched_producer_labels' ? 'COL PRODUCER NOBODY KNOWS') then
    v_failures := v_failures || E'\n  ' || 'renewal import did not report the unmatched producer label';
  end if;

  -- ── Requirement 1.1 and 1.2: raw and normalized, side by side.
  select * into v_record from public.renewal_records where policy_number = 'COL-R-0002';
  v_nonrenewal_id := v_record.id;
  if v_record.source_system <> 'renewal_collector' then
    v_failures := v_failures || E'\n  ' || 'the collector import did not stamp source_system';
  end if;
  if v_record.source_record_type <> 'No renueva' then
    v_failures := v_failures || E'\n  ' || 'the raw Spanish record type was not preserved';
  end if;
  if v_record.source_status_raw <> 'Carrier will not offer renewal' then
    v_failures := v_failures || E'\n  ' || 'the raw carrier status was not preserved';
  end if;
  if v_record.source_state_normalized <> 'carrier_nonrenewal' then
    v_failures := v_failures || E'\n  ' || 'the normalized state was not stored';
  end if;
  if v_record.source_match_status_raw <> 'Exacto' or v_record.source_match_status <> 'exact' then
    v_failures := v_failures || E'\n  ' || 'the match result was not stored raw and normalized';
  end if;
  if v_record.source_file_name <> 'consolidado_renovaciones_probe.csv'
     or v_record.source_row_number <> 2 then
    v_failures := v_failures || E'\n  ' || 'the source file name and row number were not preserved';
  end if;
  if v_record.carrier_key <> 'NATIONALGENERAL' or v_record.policy_number_normalized <> 'COL-R-0002' then
    v_failures := v_failures || E'\n  ' || 'the ownership identity was not derived on insert';
  end if;
  -- design 11.1: never labelled powerbi.
  if v_record.assignment_source = 'powerbi' then
    v_failures := v_failures || E'\n  ' || 'a collector row was labelled powerbi';
  end if;

  select * into v_record from public.renewal_records where policy_number = 'COL-R-0003';
  v_review_id := v_record.id;
  if not coalesce(v_record.source_review_required, false) then
    v_failures := v_failures || E'\n  ' || 'the unrecognized record type did not import as review-required';
  end if;
  if not coalesce(v_record.source_communication_blocked, false) then
    v_failures := v_failures || E'\n  ' || 'the review-required row was not communication-blocked';
  end if;
  if v_record.source_warning <> 'Tipo de registro no reconocido' then
    v_failures := v_failures || E'\n  ' || 'the collector warning was not preserved';
  end if;
  if v_record.source_payload ->> 'AvisosImportacion' is null then
    v_failures := v_failures || E'\n  ' || 'the source row was not preserved keyed by header';
  end if;

  -- ── Record staff work, then re-import the same file (Requirements 2.4, 13.1).
  select * into v_record from public.renewal_records where policy_number = 'COL-R-0001';

  insert into public.renewal_contacts
    (record_id, contacted_by, channel, direction, outcome, notes, occurred_at, entry_source,
     evidence_reference)
  values (v_record.id, v_agent_a, 'call', 'outbound', 'Spoke with customer',
          'Customer will decide next week', now(), 'manual', 'COL-PROBE-CALL-1');

  update public.renewal_records
     set status = 'in_progress'::public.renewal_status,
         next_follow_up_at = (v_day + 5)::timestamptz,
         import_notes = 'Staff note that must survive',
         requote_requested = true
   where id = v_record.id;

  -- One renewal is closed, to prove a later file neither reopens it nor edits it.
  select id into v_closed_id from public.renewal_records where policy_number = 'COL-R-0003';
  update public.renewal_records
     set status = 'renewed'::public.renewal_status, closed_at = now(), outcome_reason = 'Renewed as-is'
   where id = v_closed_id;

  v_second := public.renewal_import_collector_batch('consolidado_renovaciones_probe.csv', v_renewal_rows);

  if (v_second ->> 'rows_inserted')::integer <> 0 then
    v_failures := v_failures || E'\n  ' || format('re-import inserted %s rows rather than 0',
                                                 v_second ->> 'rows_inserted');
  end if;
  if (v_second ->> 'rows_updated')::integer <> 2 then
    v_failures := v_failures || E'\n  ' || format('re-import updated %s open rows rather than 2',
                                                 v_second ->> 'rows_updated');
  end if;
  if (v_second ->> 'rows_closed_preserved')::integer <> 1 then
    v_failures := v_failures || E'\n  ' || format('re-import preserved %s closed rows rather than 1',
                                                 v_second ->> 'rows_closed_preserved');
  end if;

  if (select count(*) from public.renewal_records where policy_number like 'COL-R-%') <> 3 then
    v_failures := v_failures || E'\n  ' || 'the re-import duplicated renewal records';
  end if;

  -- Requirement 13.1: every human-owned value survived.
  select * into v_record from public.renewal_records where policy_number = 'COL-R-0001';
  if v_record.status::text <> 'in_progress' then
    v_failures := v_failures || E'\n  ' || format('the re-import reset the workflow status to %s',
                                                 v_record.status::text);
  end if;
  if v_record.next_follow_up_at::date <> (v_day + 5) then
    v_failures := v_failures || E'\n  ' || 'the re-import overwrote the scheduled follow-up';
  end if;
  if v_record.import_notes <> 'Staff note that must survive' then
    v_failures := v_failures || E'\n  ' || 'the re-import overwrote the staff note';
  end if;
  if not v_record.requote_requested then
    v_failures := v_failures || E'\n  ' || 'the re-import cleared the requote flag';
  end if;
  if (select count(*) from public.renewal_contacts where record_id = v_record.id) <> 1 then
    v_failures := v_failures || E'\n  ' || 'the re-import disturbed the recorded contact history';
  end if;

  -- Requirement 2.5: the closed renewal was left exactly as it was.
  select * into v_record from public.renewal_records where id = v_closed_id;
  if v_record.status::text <> 'renewed' or v_record.outcome_reason <> 'Renewed as-is' then
    v_failures := v_failures || E'\n  ' || 'the re-import changed a closed renewal';
  end if;

  -- One owner row per policy, however many times the file is imported.
  select count(*) into v_owner_rows from public.policy_followup_policy_owners
   where policy_number_normalized like 'COL-R-%';
  if v_owner_rows <> 3 then
    v_failures := v_failures || E'\n  ' || format('%s owner rows exist for 3 policies', v_owner_rows);
  end if;

  -- ═══════════════════════════════════════════════════════════════════════════════
  -- CANCELLATIONS COLLECTOR IMPORT (design 11.2, Requirement 8.4)
  -- ═══════════════════════════════════════════════════════════════════════════════
  v_mapping := jsonb_build_object('header', jsonb_build_array(
    'Compania', 'Poliza', 'PolizaNormalizada', 'Asegurado', 'LOB', 'FechaCancelacion',
    'FechaCancelacionEstimada', 'FechaVencimientoPago', 'MontoAdeudado', 'TipoTransaccion',
    'EstadoCarrier', 'TipoRegistro', 'ClienteID', 'Titular', 'Telefonos', 'Emails',
    'EstadoHawkSoft', 'Productor', 'Idioma', 'Cruce', 'MetodoCruce', 'ArchivoOrigen',
    'FilaOrigen', 'AvisosImportacion'));

  v_cancellation_rows := jsonb_build_array(
    jsonb_build_object(
      'row_number', 1, 'source_row_number', 1,
      'policy_number', 'COL-C-0001',
      'cancellation_effective_date', (v_day + 12)::text,
      'customer_name', 'Collector Case Alpha LLC',
      'client_identifier', 'CC2001', 'customer_match_key', 'CC2001',
      'carrier', 'Progressive', 'amount_due', 412.55,
      'case_status', 'Imported', 'producer_label', 'Col Producer One',
      'legacy_send_flag', 'pending', 'legacy_state', 'Pendiente',
      'legacy_result', 'Cancelacion por falta de pago',
      'raw_row', jsonb_build_array('Progressive', 'COL-C-0001'),
      'raw_header', jsonb_build_array('Compania', 'Poliza'),
      'contacts', jsonb_build_array(
        jsonb_build_object('channel', 'phone', 'normalized_value', '+13055550201',
                           'raw_segment', '3055550201', 'validation_status', 'valid',
                           'authorization_status', 'Unknown', 'is_primary', true,
                           'segment_index', 0, 'preferred_language', 'Spanish'),
        jsonb_build_object('channel', 'email', 'normalized_value', 'case-alpha@example.invalid',
                           'raw_segment', 'case-alpha@example.invalid', 'validation_status', 'valid',
                           'authorization_status', 'Unknown', 'is_primary', true,
                           'segment_index', 0, 'preferred_language', 'Spanish'))),
    jsonb_build_object(
      'row_number', 2, 'source_row_number', 2,
      'policy_number', 'COL-C-0002',
      'cancellation_effective_date', (v_day + 20)::text,
      'customer_name', 'Collector Case Bravo Inc',
      'carrier', 'Mercury', 'amount_due', 910.10,
      -- Requirement 8.4: a paid signal moves to verification handling, never to resolved.
      'case_status', 'Payment Reported', 'producer_label', null,
      'legacy_send_flag', 'paid_signal', 'legacy_state', 'Pagada',
      'legacy_result', 'Pago recibido',
      'raw_row', jsonb_build_array('Mercury', 'COL-C-0002'),
      'raw_header', jsonb_build_array('Compania', 'Poliza'),
      'contacts', jsonb_build_array(
        jsonb_build_object('channel', 'phone', 'normalized_value', '+13055550202',
                           'raw_segment', '3055550202', 'validation_status', 'valid',
                           'authorization_status', 'Unknown', 'is_primary', true,
                           'segment_index', 0, 'preferred_language', 'English'))),
    jsonb_build_object(
      'row_number', 3, 'source_row_number', 3,
      'policy_number', 'COL-C-0003',
      'cancellation_effective_date', (v_day + 25)::text,
      'customer_name', 'Collector Case Charlie Corp',
      'carrier', 'Geico', 'amount_due', 330.00,
      'case_status', 'Import Review Required', 'producer_label', null,
      'legacy_send_flag', 'cancelled_signal', 'legacy_state', 'Cancelada',
      'legacy_result', 'Cancelacion procesada',
      'raw_row', jsonb_build_array('Geico', 'COL-C-0003'),
      'raw_header', jsonb_build_array('Compania', 'Poliza'),
      'contacts', '[]'::jsonb));

  v_run := public.cancellation_import_batch(
    'consolidado_cancelaciones_probe.csv', 'collector', v_mapping, v_cancellation_rows);

  if v_run.column_set <> 'collector' then
    v_failures := v_failures || E'\n  ' || format('the import run recorded the column set %s',
                                                 v_run.column_set);
  end if;
  if v_run.rows_created <> 3 then
    v_failures := v_failures || E'\n  ' || format('the cancellation import created %s cases rather than 3',
                                                 v_run.rows_created);
  end if;

  -- design 11.2: the collector owns the fields both legacy halves owned.
  select * into v_case from public.cancellation_cases where policy_number = 'COL-C-0001';
  if v_case.customer_name is null or v_case.carrier is null or v_case.amount_due is null
     or v_case.producer_label is null or v_case.client_identifier is null then
    v_failures := v_failures || E'\n  ' || 'the collector import did not write the eficacia-owned fields';
  end if;
  if v_case.carrier_key <> 'PROGRESSIVE' then
    v_failures := v_failures || E'\n  ' || 'the cancellation identity trigger did not run on the import';
  end if;
  if (select count(*) from public.cancellation_contacts where case_id = v_case.id) <> 2 then
    v_failures := v_failures || E'\n  ' || 'the collector import did not write the avisos-owned contacts';
  end if;

  -- Requirement 8.4.
  select * into v_case from public.cancellation_cases where policy_number = 'COL-C-0002';
  if v_case.case_status <> 'Payment Reported' then
    v_failures := v_failures || E'\n  ' || format('a paid signal imported as %s rather than Payment Reported',
                                                 v_case.case_status);
  end if;

  select * into v_case from public.cancellation_cases where policy_number = 'COL-C-0003';
  if v_case.case_status <> 'Import Review Required' then
    v_failures := v_failures || E'\n  ' || format('an ambiguous cancelled signal imported as %s',
                                                 v_case.case_status);
  end if;

  -- ── Manager work, then re-import (Requirements 2.4, 13.1).
  update public.cancellation_cases
     set assigned_to = v_agent_b, assignment_source = 'manager'
   where policy_number = 'COL-C-0001';

  select count(*) into v_contact_rows from public.cancellation_contacts;

  v_run := public.cancellation_import_batch(
    'consolidado_cancelaciones_probe.csv', 'collector', v_mapping, v_cancellation_rows);

  if v_run.rows_created <> 0 then
    v_failures := v_failures || E'\n  ' || format('the cancellation re-import created %s cases rather than 0',
                                                 v_run.rows_created);
  end if;
  if v_run.rows_updated <> 3 then
    v_failures := v_failures || E'\n  ' || format('the cancellation re-import updated %s cases rather than 3',
                                                 v_run.rows_updated);
  end if;
  if (select count(*) from public.cancellation_cases where policy_number like 'COL-C-%') <> 3 then
    v_failures := v_failures || E'\n  ' || 'the cancellation re-import duplicated cases';
  end if;
  if (select count(*) from public.cancellation_contacts) <> v_contact_rows then
    v_failures := v_failures || E'\n  ' || 'the cancellation re-import duplicated contacts';
  end if;

  select * into v_case from public.cancellation_cases where policy_number = 'COL-C-0001';
  if v_case.assigned_to is distinct from v_agent_b or v_case.assignment_source <> 'manager' then
    v_failures := v_failures || E'\n  ' || 'the cancellation re-import overrode the manager assignment';
  end if;

  -- ── The two legacy paths still classify and merge as they did.
  v_run := public.cancellation_import_batch(
    'eficacia_probe.csv', 'eficacia',
    jsonb_build_object('header', jsonb_build_array('Cliente', 'Poliza', 'FechaCancelacion')),
    jsonb_build_array(jsonb_build_object(
      'row_number', 1, 'source_row_number', 1,
      'policy_number', 'COL-LEGACY-1',
      'cancellation_effective_date', (v_day + 18)::text,
      'customer_name', 'Legacy Eficacia LLC', 'carrier', 'Travelers',
      'amount_due', 100.00, 'case_status', 'Imported',
      'raw_row', jsonb_build_array('Legacy Eficacia LLC', 'COL-LEGACY-1'),
      'raw_header', jsonb_build_array('Cliente', 'Poliza'),
      'contacts', '[]'::jsonb)));
  if v_run.rows_created <> 1 or v_run.column_set <> 'eficacia' then
    v_failures := v_failures || E'\n  ' || 'the legacy eficacia path no longer loads';
  end if;

  -- avisos may fill in a blank name but must not erase a populated one (hardening REQ-1.2).
  v_run := public.cancellation_import_batch(
    'avisos_probe.csv', 'avisos',
    jsonb_build_object('header', jsonb_build_array('Customer', 'Policy number', 'Cancellation date')),
    jsonb_build_array(jsonb_build_object(
      'row_number', 1, 'source_row_number', 1,
      'policy_number', 'COL-LEGACY-1',
      'cancellation_effective_date', (v_day + 18)::text,
      'customer_name', '', 'legacy_subject', 'Aviso de cancelacion',
      'raw_row', jsonb_build_array('', 'COL-LEGACY-1'),
      'raw_header', jsonb_build_array('Customer', 'Policy number'),
      'contacts', '[]'::jsonb)));
  select * into v_case from public.cancellation_cases where policy_number = 'COL-LEGACY-1';
  if v_case.customer_name <> 'Legacy Eficacia LLC' then
    v_failures := v_failures || E'\n  ' || 'a blank avisos name erased the eficacia name';
  end if;
  if v_case.legacy_subject <> 'Aviso de cancelacion' then
    v_failures := v_failures || E'\n  ' || 'the avisos path no longer owns its message fields';
  end if;
  if v_case.amount_due is null then
    v_failures := v_failures || E'\n  ' || 'the avisos path overwrote the eficacia amount';
  end if;

  if v_failures <> '' then
    raise exception 'COLLECTOR IMPORT VALIDATION FAILED:%', v_failures;
  end if;

  v_note := 'COLLECTOR IMPORT VALIDATION PASSED. Both collector exports import with full source '
    || 'lineage; re-import duplicated nothing and reset no staff work; a closed renewal stayed '
    || 'closed; a paid signal moved to Payment Reported; assignment was reported by source; and '
    || 'both legacy cancellation paths still own exactly the fields they owned.';
  raise exception '%', v_note;
exception
  when others then
    if sqlerrm like 'COLLECTOR IMPORT VALIDATION PASSED%' then
      raise notice '%', sqlerrm;
    else
      raise;
    end if;
end;
$validate$;
