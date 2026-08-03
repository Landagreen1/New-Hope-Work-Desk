# Tasks: cancellations-operational-hardening

Branch: `fix/cancellations-operational-hardening`

Ordering rules:
- Migration before TypeScript that depends on it.
- Pure modules before UI and routes.
- Tests sit next to the code they cover.
- Each task ends with a verification step.

Repository facts: `npm test` is `vitest --run`; type check is `npx tsc --noEmit`; build is `npm run build`; migrations apply with `node --env-file=.env.local scripts/run-sql.mjs <file>`.

---

## Tasks

- [ ] 1. Branch setup and test fixtures
  - [ ] 1.1 Create branch `fix/cancellations-operational-hardening`
    - `git switch -c fix/cancellations-operational-hardening`
    - Confirm clean working tree with `git status`

  - [ ] 1.2 Create test fixture: `eficacia_20260731.csv`
    - Path: `src/features/cancellations/__tests__/fixtures/eficacia_20260731.csv`
    - 58 data rows with header matching the `EFICACIA_COLUMNS` order: Cliente, Poliza, Compania, FechaCancelacion, MontoDebido, Enviar, Estado, Resultado, AvisosEnviados, PrimerAviso, UltimoAviso, Productor, ClienteID
    - Distribution: 54 rows with Enviar=Sí + Estado=Pendiente (active), 3 rows with Enviar=No + Estado=Pagada + Resultado=Recuperada (paid/recovered), 1 row with Enviar=No + Estado=Cancelada + Resultado=Perdida (cancelled/lost)
    - Include: 18 rows with empty Productor, 2 rows with Productor ending in "(Deleted)", 6 customers appearing on multiple policies (same Cliente, different Poliza)
    - All policy numbers and dates must be unique per row (identity constraint)
    - _Requirements: REQ-1.5, REQ-2.3, REQ-5.2_

  - [ ] 1.3 Create test fixture: `avisos_20260731_1535.csv`
    - Path: `src/features/cancellations/__tests__/fixtures/avisos_20260731_1535.csv`
    - 51 data rows with header matching `AVISOS_COLUMNS` order: Customer, Policy number, Carrier, Cancellation date, Days remaining, Aviso, Email, Phone, Asunto, MensajeEmail, MensajeSMS
    - 51 rows must share identity (policy number + cancellation date) with 51 of the 58 eficacia rows
    - Include: multiple semicolon-separated email and phone segments in several rows, some rows with empty Email or Phone, varied Aviso/Asunto/MensajeEmail/MensajeSMS content
    - 7 eficacia rows must have no matching avisos row (eficacia-only cases)
    - _Requirements: REQ-1.5, REQ-5.2_

  - [ ] 1.4 Verify fixtures parse correctly
    - Run `parseCsv` from `src/features/cancellations/import/csv.ts` against both files in a quick test
    - Confirm eficacia yields 58 data rows, avisos yields 51 data rows
    - Confirm `classifyImportFile` correctly identifies eficacia and avisos column sets

---

- [ ] 2. Forward-only migration
  - [ ] 2.1 Write `supabase/migrations/v1.10.10-cancellation-source-aware-merge.sql`
    - Add `'Import Review Required'` to `cancellation_cases.case_status` CHECK constraint (drop and recreate)
    - Add `'follow_up'` to `cancellation_events.event_type` CHECK constraint
    - Create `cancellation_import_case_rows` table (case_id, import_run_id, source_row_number, raw_row jsonb, raw_header text[], column_set text, created_at)
    - Create `cancellation_scheduler_runs` table (id, business_date, started_at, completed_at, automatic_sending_enabled, cases_evaluated, sent, skipped, failed, summary jsonb, actor_kind, actor_profile_id)
    - Create `cancellation_test_sends` table (id, case_id, touchpoint, channel, recipient, rendered_subject, rendered_body, sent_at, actor_id, delivery_result, provider_message_id, failure_reason)
    - `ALTER TABLE cancellation_settings ALTER COLUMN automatic_sending_enabled SET DEFAULT false`
    - Replace `cancellation_import_batch` function with source-aware COALESCE logic in the ON CONFLICT DO UPDATE branch
    - Add RLS policies for new tables (manager read/write for scheduler_runs and test_sends, manager read for import_case_rows)
    - Include rollback path as comments
    - _Requirements: REQ-1.1, REQ-1.3, REQ-1.4, REQ-2.2, REQ-3.1, REQ-6.4, REQ-8.1_

  - [ ] 2.2 Verify migration syntax
    - Run `npx tsc --noEmit` (should still pass — migration is SQL only)
    - Review the SQL for: no modification of historical migrations, forward-only, no DROP of pre-v1.10.x objects

---

- [ ] 3. Status mapping module
  - [ ] 3.1 Create `src/features/cancellations/import/status-mapping.ts`
    - Export `deriveImportedStatus(input: StatusMappingInput): ImportedCaseStatus`
    - Implement the five-rule truth table from design.md §2.1
    - Pure module: no React, no Supabase, no I/O
    - Export type `ImportedCaseStatus = 'Imported' | 'Reinstated' | 'Cancelled' | 'Import Review Required'`
    - Export the truthy/falsy parsing helpers as named functions for testability
    - _Requirements: REQ-2.1_

  - [ ] 3.2 Write tests for status mapping
    - Path: `src/features/cancellations/__tests__/status-mapping.test.ts`
    - Cover every row of the truth table
    - Cover case-insensitive matching (e.g., `'pendiente'` vs `'Pendiente'`)
    - Cover edge cases: null, empty string, whitespace-only, unexpected values
    - Cover the Enviar truthy variants: Sí, Si, SI, TRUE, true, 1, Yes, yes
    - Cover the Enviar falsy variants: No, NO, FALSE, false, 0, empty, null
    - Verify the fixture file yields: 54 Imported, 3 Reinstated, 1 Cancelled, 0 Import Review Required
    - _Requirements: REQ-2.1, REQ-2.3_

  - [ ] 3.3 Verify: `npm test -- --run src/features/cancellations/__tests__/status-mapping.test.ts`

---

- [ ] 4. TypeScript type updates
  - [ ] 4.1 Update `src/features/cancellations/domain/communication-status.ts`
    - Add `'Import Review Required'` to `CaseStatus` type union
    - Add `'Import Review Required'` to `CASE_STATUSES` array
    - Confirm it is NOT added to `OPEN_CASE_STATUSES` or `ACTIVE_CASE_STATUSES`
    - _Requirements: REQ-2.2, REQ-2.4_

  - [ ] 4.2 Create `src/features/cancellations/domain/follow-up.ts`
    - Export `FOLLOW_UP_OUTCOMES` const array with 11 outcome values
    - Export `FollowUpOutcome` type
    - Export `FOLLOW_UP_CONTACT_METHODS` const array: Phone, Email, SMS, WhatsApp, In-person
    - Export `FollowUpContactMethod` type
    - Export `FOLLOW_UP_DIRECTIONS` const array: Inbound, Outbound
    - Export `FollowUpDirection` type
    - Export `FollowUpPayload` interface with all form fields
    - _Requirements: REQ-6.2, REQ-6.3_

  - [ ] 4.3 Verify: `npx tsc --noEmit`

---

- [ ] 5. Import pipeline changes
  - [ ] 5.1 Integrate status mapping into `src/features/cancellations/import/fields.ts`
    - Import `deriveImportedStatus` from `./status-mapping`
    - In `parseMappedRow` for eficacia column set: read Enviar, Estado, Resultado cells, call `deriveImportedStatus`, set `fields.case_status` to the result
    - For avisos column set: leave `fields.case_status` as `null` (avisos never sets initial status)
    - For update rows: only update status if incoming is non-null and current stored status is `'Imported'` (never downgrade)
    - _Requirements: REQ-2.1, REQ-2.4_

  - [ ] 5.2 Add `statusCounts` to preview output
    - In `src/features/cancellations/import/preview.ts`:
    - Add `readonly statusCounts: Record<ImportedCaseStatus, number>` to `ImportPreview`
    - Count statuses from the plan rows during `buildImportPreview`
    - _Requirements: REQ-2.3_

  - [ ] 5.3 Create `src/features/cancellations/import/reconcile.ts`
    - Pure module implementing `reconcileImports(eficaciaPreview, avisosPreview, existingIdentities)`
    - Returns `ReconciliationSummary` with all counts from REQ-5.2
    - Matching is by identity key (normalized policy number + cancellation effective date)
    - _Requirements: REQ-5.1, REQ-5.2_

  - [ ] 5.4 Update `src/features/cancellations/import/loader.ts`
    - Insert into `cancellation_import_case_rows` for every loaded row (in the RPC, already handled by migration — verify TypeScript types match)
    - Add `listCaseImportRows` export for the drawer audit view
    - _Requirements: REQ-1.4_

  - [ ] 5.5 Verify: `npx tsc --noEmit` and `npm test -- --run src/features/cancellations/__tests__/import-preview.test.ts`

---

- [ ] 6. Complementary merge regression tests
  - [ ] 6.1 Write `src/features/cancellations/__tests__/complementary-merge.test.ts`
    - Mock Supabase client using the loader's injectable interface
    - Test scenarios:
      1. Eficacia import → avisos import: eficacia fields preserved, contacts added
      2. Avisos import → eficacia import: contacts preserved, eficacia fields written
      3. Re-import eficacia: no data loss, raw_row preserved
      4. Re-import avisos: no data loss, contacts updated not duplicated
      5. Blank eficacia Compania does not erase stored carrier
      6. Blank avisos Customer does not erase stored customer_name
      7. Manager assignment survives both reimports
      8. Contact suppression flags unchanged after reimport
    - _Requirements: REQ-1.5_

  - [ ] 6.2 Write `src/features/cancellations/__tests__/reconciliation.test.ts`
    - Load both fixture CSVs through `parseCsv` and `classifyImportFile`
    - Build previews for both
    - Call `reconcileImports` and assert counts match REQ-5.2
    - _Requirements: REQ-5.2_

  - [ ] 6.3 Verify: `npm test -- --run src/features/cancellations/__tests__/complementary-merge.test.ts src/features/cancellations/__tests__/reconciliation.test.ts`

---

- [ ] 7. Navigation and URL persistence
  - [ ] 7.1 Update `src/features/renewals/PolicyFollowUpPage.tsx`
    - Replace `useState(INITIAL_TAB)` with `useSearchParams`-driven tab selection
    - Read `?tab=cancellations` or `?tab=renewals` from URL, default to `'renewals'`
    - `selectTab` updates URL via `router.replace` with `{ scroll: false }`
    - Retain the existing `renewalsUi` / `cancellationsUi` ref logic
    - _Requirements: REQ-4.1_

  - [ ] 7.2 Update `src/app/tools/policy-follow-up/page.tsx`
    - Wrap `PolicyFollowUpPage` with `<Suspense>` for `useSearchParams` compatibility
    - _Requirements: REQ-4.1_

  - [ ] 7.3 Add direct Cancellations launcher
    - Locate the Operations Tools navigation configuration (check `src/platform/module-registry.ts` or equivalent)
    - Add entry: `{ label: 'Cancellations', href: '/tools/policy-follow-up?tab=cancellations' }`
    - _Requirements: REQ-4.2_

  - [ ] 7.4 Verify: `npx tsc --noEmit` and manual check that `/tools/policy-follow-up?tab=cancellations` loads correctly

---

- [ ] 8. Manager import UX improvements
  - [ ] 8.1 Add Import button to Cancellations header
    - In `src/features/cancellations/CancellationsPage.tsx`:
    - When `isBroadManagerRole(profile.role)`: render "Import Cancellations" button near the summary bar
    - Button opens the import wizard (same callback as existing manager action trigger)
    - _Requirements: REQ-4.3_

  - [ ] 8.2 Restructure `CancellationManagerActions.tsx`
    - Move Templates, Assignment Mapping, Automatic Sending, Data Corrections into a "Manager Settings" collapsible section
    - Import wizard remains the primary action (triggered by header button or the panel's own button)
    - _Requirements: REQ-4.4_

  - [ ] 8.3 Implement guided two-file wizard
    - Extend the wizard state machine to support: upload_eficacia → upload_avisos → reconciliation → resolve_issues → preview → complete
    - Allow skip of avisos step (eficacia-only import remains valid)
    - Allow skip of eficacia step (avisos-only import remains valid)
    - When both files present: show reconciliation panel before preview
    - _Requirements: REQ-5.1_

  - [ ] 8.4 Create `src/features/cancellations/CancellationReconciliationPanel.tsx`
    - Renders `ReconciliationSummary` counts in a card grid
    - Issue categories as expandable sections
    - "Proceed" and "Go Back" buttons
    - _Requirements: REQ-5.4_

  - [ ] 8.5 Add status preview to wizard
    - In the preview step, render `statusCounts` from the ImportPreview:
    - "54 active cases (will receive reminders)"
    - "3 paid/recovered (no reminders)"
    - "1 cancelled/lost (no reminders)"
    - _Requirements: REQ-2.3_

  - [ ] 8.6 Verify: `npx tsc --noEmit`

---

- [ ] 9. Agent follow-up recording
  - [ ] 9.1 Add `recordFollowUp` to `src/features/cancellations/api.ts`
    - Insert one `cancellation_events` row with `event_type = 'follow_up'` and full payload in `detail`
    - Update `cancellation_cases.next_required_action` if provided
    - Update `cancellation_cases.follow_up_deadline` if `next_follow_up_date` provided
    - If `payment_reported === true`, set `case_status = 'Payment Reported'`
    - Role gate: any role that `canAccessRenewals` admits, on a case assigned to that profile (or manager on any case)
    - _Requirements: REQ-6.1, REQ-6.2, REQ-6.4_

  - [ ] 9.2 Create `src/features/cancellations/CancellationFollowUpForm.tsx`
    - Form with fields from REQ-6.2
    - Outcomes from REQ-6.3 as a select
    - Notes: required, 1–4000 chars, textarea
    - Evidence: file upload (max 10 files, 100 MB each)
    - Contact method, direction, contact used (dropdown of case contacts + manual entry)
    - Next follow-up date: date picker
    - Next required action: select from NEXT_REQUIRED_ACTIONS
    - Validation: outcome required, notes required, contact method required
    - On success: calls `onChanged` prop, shows success notice, closes form
    - _Requirements: REQ-6.1, REQ-6.2, REQ-6.3_

  - [ ] 9.3 Integrate follow-up form into `CancellationDrawer.tsx`
    - Add "Record Follow-up" button below the primary action area
    - Button visible to all roles with Policy Follow-up access
    - Clicking opens the follow-up form as a slide-out section (same pattern as contact panel)
    - _Requirements: REQ-6.1, REQ-6.5_

  - [ ] 9.4 Verify: `npx tsc --noEmit`

---

- [ ] 10. Ownership clarity
  - [ ] 10.1 Add ownership filters to `src/features/cancellations/derive.ts`
    - New filter `'my-cases'`: `case.assigned_to === viewer.profileId && ACTIVE_CASE_STATUS_SET.has(case.case_status)`
    - New filter `'unassigned'`: `case.assigned_to === null && ACTIVE_CASE_STATUS_SET.has(case.case_status)`
    - New filter `'missing-producer'`: `case.producer_label !== null && case.assigned_to === null`
    - Add these to `CANCELLATION_SAVED_FILTERS` array with appropriate labels
    - Mark `'unassigned'` and `'missing-producer'` as manager-only in the filter bar
    - _Requirements: REQ-7.1, REQ-7.2_

  - [ ] 10.2 Set agent default filter
    - In `CancellationsPage.tsx` or the page container, when `!isBroadManagerRole(profile.role)`:
    - Default filter resolves to `'my-cases'` instead of `'needs-action'`
    - _Requirements: REQ-7.1_

  - [ ] 10.3 Add claim action
    - In `src/features/cancellations/api.ts`: add `claimCancellationCase(caseId, actor)`:
      - Fails if `case.assigned_to !== null`
      - Sets `assigned_to = actor.id`, `assignment_source = 'claim'`
      - Inserts `cancellation_events` with `event_type = 'assignment'`
    - In `CancellationDrawer.tsx`: show "Claim This Case" button when case is unassigned and viewer is not a manager
    - For managers: show "Quick Assign" dropdown for unassigned cases in table row actions
    - _Requirements: REQ-7.3_

  - [ ] 10.4 Verify: `npx tsc --noEmit`

---

- [ ] 11. Automatic sending safety
  - [ ] 11.1 Create `src/app/api/cancellations/readiness/route.ts`
    - POST handler, manager-only (session-gated via `requireToolProfile(canAccessRenewals)` + `isBroadManagerRole`)
    - Check env vars: CRON_SECRET, RINGCENTRAL_JWT_TOKEN (or equivalent RC vars), RESEND_API_KEY, SUPABASE_SECRET_KEY
    - Query `cancellation_settings` for existence and `automatic_sending_enabled`
    - Query `cancellation_templates` + `cancellation_template_versions` for four touchpoints with ≥1 version each
    - Query `cancellation_scheduler_runs` for last row
    - Query `cancellation_cases` for failed comm count and missing-contact count
    - Return `ReadinessReport` JSON
    - _Requirements: REQ-3.2, REQ-8.1_

  - [ ] 11.2 Create `src/features/cancellations/CancellationReadinessPanel.tsx`
    - Calls `POST /api/cancellations/readiness` on mount
    - Renders checklist with ✓/✗ for each readiness item
    - Shows automatic-sending toggle (disabled when any check fails)
    - Shows "Send Test Message" button opening test-send form
    - Shows last scheduler run info
    - Shows failed communication count and missing-contact count
    - _Requirements: REQ-3.2, REQ-3.3_

  - [ ] 11.3 Create `src/features/cancellations/scheduler/test-send.ts`
    - Export `runTestSend(input: TestSendInput): Promise<TestSendResult>`
    - Accepts `testRecipient: { phone?: string; email?: string }`, `caseId`, `touchpoint`
    - Renders template for the case + touchpoint using the real renderer
    - Sends to test recipient only (never to case contacts)
    - Records in `cancellation_test_sends` table
    - Never writes to `cancellation_communications`
    - _Requirements: REQ-3.4_

  - [ ] 11.4 Update `src/features/cancellations/scheduler/run.ts`
    - At run start: insert into `cancellation_scheduler_runs`
    - At run end: update with `completed_at`, counts, summary jsonb
    - _Requirements: REQ-3.2, REQ-8.1_

  - [ ] 11.5 Verify: `npx tsc --noEmit`

---

- [ ] 12. Integration and regression testing
  - [ ] 12.1 Run all existing cancellation tests
    - `npm test -- --run src/features/cancellations/`
    - All must pass without modification (proving no regression)

  - [ ] 12.2 Run new tests
    - `npm test -- --run src/features/cancellations/__tests__/status-mapping.test.ts`
    - `npm test -- --run src/features/cancellations/__tests__/complementary-merge.test.ts`
    - `npm test -- --run src/features/cancellations/__tests__/reconciliation.test.ts`

  - [ ] 12.3 Type check
    - `npx tsc --noEmit` — zero errors

  - [ ] 12.4 Production build
    - `npm run build` — succeeds

---

- [ ] 13. Commit and deliverables
  - [ ] 13.1 Commit
    - Stage all changed and new files
    - `git commit -m "fix(cancellations): operational hardening — source-aware merge, status mapping, guided import, follow-up recording, ownership, readiness"`

  - [ ] 13.2 Produce deliverables
    - List all files changed (git diff --stat)
    - Document the new migration
    - Run both test fixtures through the import pipeline (unit test output showing counts)
    - Capture manager import flow screenshots (describe UI states)
    - Capture agent follow-up flow screenshots (describe UI states)
    - Write deployment readiness report based on REQ-8.3
    - Report exact test results from tasks 12.1–12.4

---

## Verification Record

_(Filled during implementation)_

### Pre-branch working tree
<!-- git status output -->

### Test results — existing tests
<!-- npm test output for cancellations/ -->

### Test results — new tests
<!-- status-mapping, complementary-merge, reconciliation -->

### Type check
<!-- npx tsc --noEmit output -->

### Build
<!-- npm run build output -->

### Import simulation results
<!-- Before: single-file import behavior -->
<!-- After: two-file guided import with reconciliation counts -->
