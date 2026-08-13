# Implementation Plan: Policy Follow-up (Renewals + Cancellations)

## Overview

Two implementation phases on `feature/renewals-cancellations`, separated by a hard verification barrier.

**Phase 1** rewrites the Renewals UI into the six components plus a page container over the untouched `src/features/renewals/api.ts` surface, adds the `Policy Follow-up` tab shell and route, and ends with one verification run and the commit `feat(renewals): simplify renewal workspace`. No migration, RPC, table, column, or bucket change.

**Phase 2** adds the Cancellations module: the v1.10.0–v1.10.9 migrations, the RFC 4180 importer, the versioned bilingual renderer with its prohibited-phrase and forbidden-token gate, the reserve-then-send scheduler over RingCentral SMS and the new `src/lib/email.ts`, and the payment/reinstatement outcome UI. Ends with one verification run including integration tests and the commit `feat(cancellations): add reminder and tracking workflow`.

Ordering rules that shape the sequence:

- **Migrations before the code that calls them.** `cancellation_import_batch` (v1.10.5) exists before the loader; the idempotency constraint (v1.10.2) exists before the scheduler.
- **Pure modules before UI and routes.** `derive.ts`, `csv.ts`, `contacts.ts`, `renderMessage`, `deriveCommunicationStatus`, and `evaluateEscalations` have no React and no I/O, so each is proven in isolation before anything consumes it.
- **Tests sit next to the code they cover**, not batched at the end.
- **Phase 1 gate is a barrier.** No Phase 2 task starts until one verification run reports zero type errors, zero failing tests, and zero build errors (Requirements 7.3, 7.5, 25.8).

Repository facts used by every task: `npm test` is `vitest --run`; `npm run test:integration` runs `*.integration.test.*` with `.env.local` loaded; there is no `typecheck` script, so the type check is `npx tsc --noEmit`; the build is `npm run build`; migrations apply with `node --env-file=.env.local scripts/run-sql.mjs <file>`. SMS goes through the existing `src/lib/ringcentral-sms.ts` only. Every `manager` role check also accepts `super_admin`.

---

## Tasks

- [x] 0. Branch setup
  - [x] 0.1 Record the current working-tree state
    - Run `git status --porcelain` and `git branch --show-current`; write the list of already-modified and untracked paths into the Verification Record section of this file under "Pre-branch working tree"
    - Confirm no path in that list is inside `src/features/renewals`, `src/app/tools/renewals`, `src/platform/module-registry.ts`, or `supabase/migrations`; list any that is, so it is not mistaken for Phase 1 work
    - _Requirements: 26.7_

  - [x] 0.2 Create `feature/renewals-cancellations` carrying the unrelated changes forward
    - Run `git switch -c feature/renewals-cancellations` (no stash, no checkout of tracked files, no `git add`)
    - Re-run `git status --porcelain` and confirm the path list is identical to the one recorded in 0.1
    - Leave the unrelated changes unstaged so neither Phase commit picks them up
    - _Requirements: 26.7_

- [x] 1. Phase 1: Renewal derived-value helpers
  - [x] 1.1 Create `src/features/renewals/derive.ts` with the nine pure helpers
    - New file `src/features/renewals/derive.ts`: no React import, no `getSupabase()`, no `.rpc(`, no `Date.now()` outside `currentBusinessDate`
    - Export `currentBusinessDate(now, timeZone)`, `daysRemaining(renewalDate, businessDate)`, `premiumChange(current, renewal)`, `isOpenRenewal(record)`, `matchesSummaryFilter(record, contacts, filterId, businessDate)`, `summaryCounts(records, contactIndex, searchText, businessDate)`, `matchesSearch(record, searchText)`, `compareRenewalRows(a, b, businessDate)`, `recommendedNextAction(record, contacts, requotes)`
    - `matchesSummaryFilter` covers the ten filter ids; the four `Due within N days` windows are inclusive on both bounds and cumulative; records with no next follow-up date fall out of both follow-up filters and stay eligible for the rest
    - `compareRenewalRows` applies the five sort keys in order: overdue first, renewal date ascending, no-contact first, customer name ascending case-insensitive, policy number ascending case-insensitive
    - `recommendedNextAction` is one ordered array of `{ action, when }` predicates returning the first match across the six rules
    - `premiumChange` returns `null` when either side is absent, otherwise the signed amount rounded to two decimals plus the percentage
    - _Requirements: 3.5, 3.6, 3.7, 3.8, 3.9, 4.2, 4.5, 4.7, 4.8, 5.2_

  - [x] 1.2 Write unit tests for `derive.ts`
    - New file `src/features/renewals/__tests__/derive.test.ts`
    - Cover: each of the ten summary filter counting rules; cumulative window boundaries at exactly N and N+1 days; `daysRemaining` returning `0` on the business date and a negative value before it; premium change sign for negative, positive, and zero; search text trimmed and truncated to 100 characters with an empty search matching every record; the five-key sort producing a total order on ties; each of the six `recommendedNextAction` rules including Rule 3 beating Rule 4 and Rule 6 as the fallback
    - _Requirements: 3.7, 3.8, 3.9, 4.2, 4.5, 4.7, 4.8, 5.2, 25.1_

- [x] 2. Presentational renewal components
  - [x] 2.1 Create `src/features/renewals/RenewalsSummaryBar.tsx`
    - Renders the ten summary filters with the counts supplied as props from `summaryCounts`; at most one filter active; selecting the active filter clears it; zero data access in the file
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 7.1, 7.2_

  - [x] 2.2 Create `src/features/renewals/RenewalsTable.tsx`
    - Renders the fourteen cells per row from props in the Requirement 4.1 order, `Unassigned` for no assigned employee, an em dash for every other absent value and for an absent premium change, row click raising `onSelect`, and a loading indicator slot for the first page of at most 50 records
    - _Requirements: 4.1, 4.3, 4.4, 4.6, 4.9, 1.5, 7.1, 7.2_

  - [x] 2.3 Create `src/features/renewals/RenewalTimeline.tsx`
    - Pure props: merged contact entries, status changes, assignment changes, follow-up date changes, requote activity, and recorded outcomes, ordered by event time descending with the later-recorded entry first on equal times
    - _Requirements: 5.8, 1.4, 7.1, 7.2_

- [x] 3. Contact composer and detail drawer
  - [x] 3.1 Create `src/features/renewals/RenewalContactComposer.tsx`
    - Channel select restricted to call, SMS, WhatsApp, email, in person, other; notes required at 1 to 5,000 non-whitespace-trimmed characters; attachment guard at 10 files and 100 MB per file; calls only `addContact`, `getEvidenceUrl`, `downloadEvidenceFile` from `api.ts`
    - On rejection or upload failure retain the entered channel, notes text, and previously accepted attachments, show the failed limit or upload reason, and offer retry
    - _Requirements: 5.4, 5.5, 5.6, 5.7, 5.9, 2.3, 7.1, 7.2_

  - [x] 3.2 Create `src/features/renewals/RenewalDrawer.tsx`
    - Renders every Requirement 5.1 field, hosts `RenewalContactComposer` and `RenewalTimeline`, and renders the control for the recommended next action as the only prominent primary control
    - Owns contacts, events, and SMS logs for the selected record via `listContacts`, `listRenewalEvents`, `listSmsLogs`; writes via `updateWorkflow`, `updateRenewalContactInfo`, `sendToRequote`, `sendRenewalSms`
    - Next follow-up date rejected outside the business date through business date + 365 days; outcome restricted to Renewed, Lost, Cancelled with required note text; on success refresh its own detail queries and call `onRecordChanged` without closing
    - Any `api.ts` error shows a message naming the attempted renewal operation and keeps the entered form values
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.10, 5.11, 2.2, 2.7, 7.1, 7.2_

  - [x] 3.3 Write unit tests for the drawer and composer actions
    - New file `src/features/renewals/__tests__/renewal-actions.test.ts`
    - Cover: contact logging stores channel, notes, time, profile, and evidence references; whitespace-only notes rejected and the composer state retained; notes over 5,000 characters rejected; absent or out-of-set channel rejected; follow-up date before the business date and after +365 days rejected with the stored value retained; requote creation through `sendToRequote`; each of Renewed, Lost, Cancelled stored with note, profile, and time; an `api.ts` error path leaving the record unchanged
    - _Requirements: 5.4, 5.5, 5.9, 5.10, 5.11, 2.2, 2.3, 2.7, 25.1_

  - [x] 3.4 Write unit tests for evidence limits
    - New file `src/features/renewals/__tests__/renewal-evidence.test.ts`
    - Cover: a file over 100 MB rejected with the limit displayed; an 11th attachment rejected; previously accepted attachments retained; upload failure and the 120-second timeout leaving the contact entry unsaved with the timeline unchanged and retry offered
    - _Requirements: 5.6, 5.7, 25.1_

- [x] 4. Manager actions
  - [x] 4.1 Create `src/features/renewals/RenewalManagerActions.tsx`
    - Absorbs the whole of `PowerBiRenewalImport.tsx` (import wizard, `parseCsv`, `guessMapping`, `buildNormalizedRows`, `extractDistinctAssignmentLabels`, `importBatch`, alias upsert and delete, unmatched review) behind one collapsed control
    - Exposes exactly the six controls Import renewals, Assignment mapping, Reassign renewal, Correct imported data, Review unmatched assignments, View all employees; renders nothing at all when the profile role is not `manager` or `super_admin`
    - Import completion shows rows inserted, updated, skipped, assigned as non-negative integers with zero for absent counts, plus every unmatched label and the label count, held until dismissed or a new import starts; an import error reports all four counts as zero
    - Delete `src/features/renewals/PowerBiRenewalImport.tsx` once no import behavior remains outside this file
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.2, 7.4_

  - [x] 4.2 Write unit tests for manager actions
    - New file `src/features/renewals/__tests__/renewal-manager-actions.test.ts`
    - Cover: renewal import through `importBatch` reporting the four counts; assignment mapping alias upsert and delete; employee assignment through `assignRenewal`; unmatched assignment review listing each label with its unassigned row count; an `importBatch` error reporting four zeros and leaving records unchanged; a non-manager request rejected with no record and no alias change
    - _Requirements: 6.5, 6.6, 6.7, 6.8, 25.1_

- [x] 5. Page container, tab shell, and routing
  - [x] 5.1 Rewrite `src/features/renewals/RenewalsPage.tsx` as the page container
    - Holds every `api.ts` read: `listRenewals`, `listRenewalAssignees`, `listRenewalAssignmentAliases`, `listRenewalImportRuns`, `listRenewalSyncExceptions`
    - Owns records, load/error/retry state, search text, the single active summary filter, sort order, selected record id, manager-menu open state, and the business date computed once per render pass; passes derived props down from `derive.ts`
    - Composes `RenewalsSummaryBar`, `RenewalsTable`, `RenewalDrawer`, `RenewalManagerActions`; keeps the previously loaded records, search text, filter, and sort on a failed or 15-second query and offers retry that re-runs with the retained values
    - _Requirements: 2.1, 2.4, 2.7, 3.2, 3.3, 3.4, 4.5, 4.6, 1.5, 1.6, 1.7, 1.9, 1.10, 7.2_

  - [x] 5.2 Create `src/features/renewals/PolicyFollowUpPage.tsx` tab shell
    - Exactly two tabs labeled Renewals then Cancellations; Renewals selected on every fresh page load regardless of the tab selected in an earlier load
    - Retains `{ searchText, savedFilter, sortOrder }` per tab for the current page load, restores all three on return, and closes the detail drawer of the tab being left
    - Switches tabs client-side, rendering the target list surface or loading indicator without a page reload; the Cancellations tab renders an inert placeholder until task 16.12 wires `CancellationsPage`
    - Exposes no control that creates a to-do, task, task template, task board, drag-and-drop arrangement, or user-defined workflow state
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.8, 1.11_

  - [x] 5.3 Add the `policy-follow-up` route and module-registry entry
    - New file `src/app/tools/policy-follow-up/page.tsx` with `export const dynamic = 'force-dynamic'`, `const profile = await requireToolProfile(canAccessRenewals)`, rendering `PolicyFollowUpPage` with `initialProfile`
    - In `src/platform/module-registry.ts` add the `policy-follow-up` entry with `route: '/tools/policy-follow-up'` and `roles: rolesWhere(canAccessRenewals)`, and retarget the existing `renewals` entry's `route` to `/tools/policy-follow-up` without removing the entry
    - Leave `canAccessRenewals` in `src/lib/permissions.ts` unchanged
    - _Requirements: 2.5, 2.9, 22.5_

  - [x] 5.4 Reduce `src/app/tools/renewals/page.tsx` to a redirect
    - Replace the file body with a server redirect to `/tools/policy-follow-up`, keeping `requireToolProfile(canAccessRenewals)` ahead of the redirect so an unauthorized profile is still denied and reads zero renewal rows
    - _Requirements: 2.5, 2.9_

  - [x] 5.5 Write permission and structural tests
    - New file `src/features/renewals/__tests__/renewal-permissions.test.ts`
    - Cover: `canAccessRenewals` returns the same accept/deny result for every role in `APP_ROLES` as the pre-revision set; the manager menu is absent from the rendered output for `agent`, `customer_service`, `sales_supervisor` and present for `manager` and `super_admin`; a static assertion that `RenewalsSummaryBar.tsx`, `RenewalsTable.tsx`, `RenewalDrawer.tsx`, `RenewalContactComposer.tsx`, `RenewalTimeline.tsx`, and `RenewalManagerActions.tsx` contain zero `getSupabase(` and zero `.rpc(` occurrences
    - _Requirements: 2.5, 2.9, 6.2, 6.4, 7.2, 25.1_

- [x] 6. Phase 1 verification gate and commit
  - [x] 6.1 Measure the line budget
    - Record the pre-revision combined source line count of `RenewalsPage.tsx` and `PowerBiRenewalImport.tsx` (taken from `git show` of the pre-Phase-1 commit, since `PowerBiRenewalImport.tsx` is deleted in 4.1) and the post-revision total of the six components plus `RenewalsPage.tsx`, using the same counting command for both
    - Write both numbers into the Verification Record section; if the post-revision total exceeds the baseline, reduce it before the gate runs
    - Confirm no renewal UI component file exists outside the six named in Requirement 7.1
    - _Requirements: 7.4, 7.6_

  - [x] 6.2 Phase 1 verification gate — one run, three results
    - In a single verification run execute, in order, `npx tsc --noEmit`, then `npm test`, then `npm run build` (there is no `typecheck` script)
    - Record all three outcomes plus the run identifier (UTC timestamp and `git rev-parse HEAD`) in the Verification Record section; any non-zero error count or failing test voids the record, and the whole sequence must be re-run after the fix
    - No Phase 2 task starts until this one run reports zero type errors, zero failing tests, and zero build errors
    - _Requirements: 7.3, 7.5, 25.1, 25.8_

  - [x] 6.3 Commit Phase 1
    - Stage only the Phase 1 paths (`src/features/renewals/**`, `src/features/renewals/PolicyFollowUpPage.tsx`, `src/app/tools/policy-follow-up/page.tsx`, `src/app/tools/renewals/page.tsx`, `src/platform/module-registry.ts`, this tasks file) by name, leaving the unrelated changes from 0.1 unstaged
    - Commit with the title `feat(renewals): simplify renewal workspace`
    - _Requirements: 26.7_

- [x] 7. Phase 2: Cancellation migrations v1.10.0 through v1.10.9
  - **Blocked until task 6.2 records three zero results from one run.**

  - [x] 7.1 Write and apply `supabase/migrations/v1.10.0-cancellation-core-tables.sql`
    - `cancellation_import_runs`, `cancellation_cases`, `cancellation_contacts`, `cancellation_suppressions`, `cancellation_events` with the columns, checks, and defaults in the design data model
    - `cancellation_cases.policy_number_normalized` generated stored from `upper(regexp_replace(policy_number, '\s', '', 'g'))`; `unique (policy_number_normalized, cancellation_effective_date)`; `raw_row jsonb` holding a JSON array plus `raw_header text[]`
    - `cancellation_contacts` `unique (case_id, channel, normalized_value)`; `cancellation_suppressions` partial unique index on `(channel, normalized_value) where cleared_at is null`
    - `cancellation_events` append-only with `sequence bigserial` and a `before update or delete` trigger that raises
    - Helper functions `public.cancellation_is_manager()` and `public.cancellation_can_read_all()`, both `security definer`, `set search_path = public`, with `manager` and `super_admin` accepted by the manager helper
    - Apply with `node --env-file=.env.local scripts/run-sql.mjs supabase/migrations/v1.10.0-cancellation-core-tables.sql`; touch no file at v1.9.7 or earlier and include no drop or truncate of anything created at v1.9.7 or earlier
    - _Requirements: 9.1, 10.6, 10.9, 22.8, 22.9, 24.1, 26.1, 26.2_

  - [x] 7.2 Write and apply `supabase/migrations/v1.10.1-cancellation-templates.sql`
    - `cancellation_templates` with `unique (touchpoint)` over `(15,10,5,1)`; `cancellation_template_versions` with `unique (template_id, version, language)`, `subject`, `body`, `cancellation_statement`, `contact_request`, `fallback_text jsonb`; `cancellation_prohibited_phrases` with the five `claim_category` values and `is_active`
    - `before update or delete` trigger on `cancellation_template_versions` that raises, so a saved change can only add `version + 1` rows
    - Apply with `scripts/run-sql.mjs`
    - _Requirements: 11.1, 14.7, 14.11, 14.17, 26.1_

  - [x] 7.3 Write and apply `supabase/migrations/v1.10.2-cancellation-communications.sql`
    - `cancellation_communications` with `unique (case_id, contact_id, touchpoint, channel)` as the Idempotency_Key, `rendered_subject text not null default ''`, `rendered_body`, `delivery_result` in `('Sent','Delivered','Failed')`, `attempt_count`, `combined_group_id`, and `on delete restrict` on both foreign keys
    - `cancellation_communication_cases` link table with `unique (communication_id, case_id)` and an index on `combined_group_id`
    - `before update` trigger rejecting any change to `case_id`, `contact_id`, `touchpoint`, `channel`, `template_version_id`, `rendered_subject`, `rendered_body`, and rejecting every update that does not carry the transaction-local retry marker; `before delete` always raises
    - `public.cancellation_retry_communication(...)` security-definer function, callable by `manager`, `super_admin`, or the service role, that sets the marker and updates only `send_time`, `provider_message_id`, `delivery_result`, `failure_reason`, `attempt_count`
    - Apply with `scripts/run-sql.mjs`
    - _Requirements: 12.6, 13.4, 13.8, 14.15, 14.16, 17.6, 22.8, 26.1_

  - [x] 7.4 Write and apply `supabase/migrations/v1.10.3-cancellation-case-activity.sql`
    - `cancellation_notes` (note 1..4000, `evidence jsonb`), `cancellation_customer_responses` (six response types, channel, time, note), `cancellation_payment_reports` (amount 0.01..999999999.99, reference ≤ 100 chars, note 1..2000, evidence), `cancellation_verification_outcomes` (the seven outcome values, `next_case_status`, `next_required_action`, evidence), `cancellation_escalations` (the seven reasons, `raised_at`, `cleared_at`, `cleared_by`, `notified_at`, `unique (case_id, reason)`)
    - Apply with `scripts/run-sql.mjs`
    - _Requirements: 17.8, 18.5, 18.6, 19.1, 20.10, 21.5, 26.1_

  - [x] 7.5 Write and apply `supabase/migrations/v1.10.4-cancellation-settings.sql`
    - `cancellation_settings` single-row table (`id boolean primary key default true check (id)`) with `automatic_sending_enabled boolean not null default true`, `office_phone`, `agency_name default 'New Hope Insurance Agency'`, `bilingual_separator`, `holidays date[]`, `updated_by`, `updated_at`; seed the single row
    - Apply with `scripts/run-sql.mjs`
    - _Requirements: 14.1, 14.4, 18.4, 26.4_

  - [x] 7.6 Write and apply `supabase/migrations/v1.10.5-cancellation-import-batch.sql`
    - `cancellation_import_batch(p_file_name text, p_column_set text, p_mapping jsonb, p_rows jsonb)` security-definer, one transaction: insert the import run, upsert cases on the identity constraint updating only import-sourced columns, insert contacts, run the escalation evaluation, return the run row
    - Update path preserves `case_status`, `communication_status`, suppression, authorization, preferred language, communications, notes, responses, audit rows, and any manager-recorded assignment; create path sets `case_status = 'Imported'` and `communication_status = 'Not Scheduled'`
    - `cancellation_recompute_communication_status(p_case_id uuid)` applying the nine-value precedence order
    - Apply with `scripts/run-sql.mjs`
    - _Requirements: 8.7, 8.8, 9.2, 9.8, 15.9, 15.10, 15.11, 24.1_

  - [x] 7.7 Write and apply `supabase/migrations/v1.10.6-cancellation-rls.sql`
    - `enable row level security` on every `cancellation_*` table plus every policy in the design RLS table, built on `cancellation_is_manager()` and `cancellation_can_read_all()`
    - `agent` reads only cases assigned to self or unassigned and may set only `Open`, `Payment Reported`, `Verification Pending`, `Reinstatement Pending`; `customer_service` and `sales_supervisor` read all and write only rows assigned to self; `manager` and `super_admin` read all, insert, and update any column
    - `cancellation_communications` and `cancellation_events` are insert-only for every role with no delete policy on any table; `cancellation_verification_outcomes` insert is manager-only; `cancellation_import_runs` is unreadable by `agent`
    - Apply with `scripts/run-sql.mjs`
    - _Requirements: 19.11, 22.1, 22.2, 22.3, 22.5, 22.8, 22.9, 22.10, 22.12_

  - [x] 7.8 Write and apply `supabase/migrations/v1.10.7-extend-user-notifications-type.sql`
    - Drop and re-add only the `public.user_notifications` `notification_type` check constraint so it allows `'turn'`, `'assignment'`, and `'cancellation_follow_up'`; no column added, no row touched, no other statement in the file
    - Apply with `scripts/run-sql.mjs`
    - _Requirements: 20.8, 26.1, 26.2_

  - [x] 7.9 Write and apply `supabase/migrations/v1.10.8-cancellation-evidence-bucket.sql`
    - Create the `cancellation-evidence` storage bucket, private, with the same policy shape as `renewal-contact-evidence`: authenticated insert for readable cases, download only through a signed URL, no public read, no delete policy
    - Apply with `scripts/run-sql.mjs`
    - _Requirements: 17.9, 18.6, 18.10, 19.9_

  - [x] 7.10 Write and apply `supabase/migrations/v1.10.9-cancellation-seed-templates.sql`
    - Seed the four templates (15, 10, 5, 1) and their version 1 English and Spanish rows, each carrying the cancellation-scheduled statement, the contact request, `Agency_Name`, and the `Office_Phone` token, plus `fallback_text` entries for producer name, amount due, contact name, carrier, and cancellation reason
    - Seed `cancellation_prohibited_phrases` with at least one English and one Spanish phrase for each of the five claim categories
    - Apply with `scripts/run-sql.mjs`
    - _Requirements: 11.6, 12.1, 14.2, 14.5, 14.7, 14.11_

- [x] 8. RFC 4180 raw-row reader
  - [x] 8.1 Create `src/features/cancellations/import/csv.ts`
    - `parseCsv(text)` returning `{ header: string[]; rows: string[][]; rowNumbers: number[] }`: quoted fields honored, doubled quotes collapsed to one, embedded CR/LF retained in source form, no trimming, no case folding, no Unicode normalization, no numeric or date conversion, no truncation, leading BOM stripped from the first header field only
    - `serializeRawRow(values: string[]): string` quoting a field only when it contains `,`, `"`, CR, or LF, doubling inner quotes, joining with `,`
    - `normalizeAcceptable(row: string)` implementing exactly the Requirement 24.6 acceptable-difference set and nothing else
    - Do not reuse or modify `parseCsv` in `src/features/renewals/api.ts`; it trims and drops empty rows
    - _Requirements: 24.1, 24.2, 24.4, 24.6, 24.7_

  - [x] 8.2 Write the CSV round-trip property test
    - New file `src/features/cancellations/import/__tests__/csv-round-trip.property.test.ts`
    - **Property 1: CSV raw-row round trip**
    - Header comment `// Feature: policy-follow-up-renewals-cancellations, Property 1: For any CSV data row of 1 to 30 fields whose field values are arbitrary strings of 0 to 10,000 characters, storing that row as a raw row and re-serializing it produces a CSV row whose field count, field order, and decoded field values are equal character for character to the source row, where the only permitted differences are those enumerated in Requirement 24 criterion 6.`
    - `fc.assert(..., { numRuns: 100 })` minimum; `fc.array(fieldArb, { minLength: 1, maxLength: 30 })` with `fieldArb` weighted over empty string, plain ASCII, embedded `,`, embedded `"` and `""`, embedded `\n` and `\r\n`, leading-zero digit strings such as `007`, accented and non-Latin characters, and a value near 10,000 characters
    - Assert field count and field order separately from `normalizeAcceptable(serializeRawRow(parseRow(source))) === normalizeAcceptable(source)` so a count or order difference cannot be masked
    - **Validates: Requirements 24.1, 24.2, 24.3, 24.4, 24.7, 25.4**
    - _Requirements: 24.2, 24.3, 24.4, 24.7, 25.4_

- [x] 9. Classification, mapping, preview, and the batch loader
  - [x] 9.1 Create `src/features/cancellations/import/classify.ts`
    - Header containing `Poliza` and `FechaCancelacion` classifies `eficacia`; containing `Policy number` and `Cancellation date` without `Poliza` classifies `avisos`; header matching is trimmed and case-insensitive
    - File-level rejection for an unrecognized header set, a file over 25 MB, zero data rows, and more than 20,000 data rows, each returning the unmet condition and the required column names; absent columns of the classified set become absent values for every row
    - _Requirements: 8.1, 8.2, 8.3, 8.13_

  - [x] 9.2 Create `src/features/cancellations/import/mapping.ts`
    - Propose header to column by trimmed case-insensitive equality, leave unmatched headers unmapped, accept manager overrides for every proposal, and block confirmation until the policy number and cancellation effective date columns are mapped
    - _Requirements: 8.4_

  - [x] 9.3 Create `src/features/cancellations/import/fields.ts` row-level parsers
    - `normalizePolicyNumber` (strip all whitespace, upper-case, keep leading zeros and hyphens), `parseCancellationDate` (`YYYY-MM-DD` and `M/D/YYYY` only, non-existent calendar dates unparseable), `parseAmountDue` (optional currency symbol, comma groups, 1–2 decimals, range 0.00–999,999,999.99; empty, whitespace, `nan`, `NaN`, `None`, `null`, `undefined`, and unparseable values return absent with a reason)
    - `clientIdentifier` stored as the exact decoded characters with trim only, no numeric conversion, no zero-stripping, no zero-padding; `customerMatchKey` = client identifier else normalized customer name, `null` at zero characters
    - `normalizeProducerLabel` (trim, collapse internal whitespace, upper-case) plus the `(Deleted)` suffix rule, both leaving `assigned_to` unresolved and returning the label with its row number
    - Legacy passthrough for `Enviar`, `Estado`, `Resultado`, `AvisosEnviados`, `PrimerAviso`, `UltimoAviso`, `Days remaining`, `Aviso`, `Asunto`, `MensajeEmail`, `MensajeSMS`, each stored verbatim and excluded from status, scheduling, and template selection
    - Pre-insert self-check `serializeRawRow(parse(row)) ≡ row` under `normalizeAcceptable`, rejecting the row with reason `source row could not be preserved`
    - _Requirements: 8.6, 8.10, 8.11, 8.12, 8.14, 8.15, 9.1, 9.5, 9.6, 9.7, 9.9, 9.11, 24.3, 24.8_

  - [x] 9.4 Create `src/features/cancellations/import/preview.ts`
    - Pure function over parsed rows plus the confirmed mapping returning the five counts (data rows, will create, will update, rejected, duplicate), the rejected list with data row number and reason, the duplicate list keeping the lowest source row number per identity, the unmatched producer label list, the unmatched customer row list, and the invalid-contact and contact-overflow counts; writes nothing
    - _Requirements: 8.5, 8.6, 9.4, 9.11_

  - [x] 9.5 Create `src/features/cancellations/import/loader.ts`
    - Single call to `cancellation_import_batch(p_file_name, p_column_set, p_mapping, p_rows)` with `raw_row` as a JSON array in source column order and `raw_header` in matching order; returns the import run row
    - Rejected rows do not abort the batch: accepted rows still load and every rejection is reported with its data row number and reason
    - _Requirements: 8.7, 8.8, 8.9, 9.2, 9.3, 9.8, 15.10, 15.11, 20.10_

  - [x] 9.6 Write import classification, parsing, and preview tests
    - New files `src/features/cancellations/import/__tests__/import-classify.test.ts` and `import-preview.test.ts`
    - Cover: an `eficacia` header set and an `avisos` header set classified correctly and a third header set rejected whole; over-25 MB, zero-row, and over-20,000-row rejection; empty policy number and unparseable or non-existent date rejected with row numbers; `MontoDebido` empty and `nan` stored absent with a reason while the rest of the row loads; a `(Deleted)` producer label leaving the case unassigned; two rows sharing an identity loading the lowest row number and counting the other as duplicate; same policy number with a different effective date creating a second case; two cases sharing a client identifier resolving to one matched customer and a blank match key excluded from grouping; re-importing the byte-identical file creating zero additional cases and contacts and counting every accepted row as an update
    - _Requirements: 8.2, 8.3, 8.6, 8.13, 8.15, 9.3, 9.4, 9.5, 9.7, 9.9, 9.10, 9.11, 24.5, 25.2_

- [x] 10. Contact normalization and suppression
  - [x] 10.1 Create `src/features/cancellations/import/contacts.ts`
    - Split phone and email cells on `;`, trim space, tab, CR, LF per segment, skip zero-non-whitespace segments, cap at 20 rows per case per channel and return the overflow count
    - Phone reduction to digits plus a leading `+` only from position 1, then the three E.164 forms; any other shape stores the trimmed segment and marks `invalid`
    - Email lower-cased, validated for exactly one `@`, at least one character before it, at least one character between `@` and the first following dot, at least one dot after `@`, at least two characters after the last dot, no whitespace, total length 6 to 254
    - Dedup per case and channel keeping the earliest `segment_index`; primary set on the first retained row per channel; `authorization_status = 'Unknown'`, both suppression flags cleared on creation; invalid rows retained and counted
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.11, 10.12, 10.13_

  - [x] 10.2 Write contact normalization tests
    - New file `src/features/cancellations/import/__tests__/contact-normalization.test.ts`
    - Cover: a multi-email cell and a multi-phone cell producing one row per segment with primary on the first; 10-digit, 11-digit-leading-1, and `+`-prefixed 11–15-digit forms; a malformed phone stored trimmed and marked invalid with the case still loading; each email validation clause failing independently; duplicate normalized values keeping the earlier segment; a 21st segment counted as overflow
    - _Requirements: 10.1, 10.2, 10.4, 10.6, 10.7, 10.8, 10.11, 10.12, 10.13, 25.2_

  - [x] 10.3 Create `src/features/cancellations/domain/suppression.ts`
    - `suppressChannel(channel, normalizedValue, source, actorId, reason)` writing one active `cancellation_suppressions` row per channel and value and applying to every case holding that value, including contacts created by later imports
    - `matchesOptOutKeyword(text)` for STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT after trim and case folding, used for the `customer inbound message` source with no actor
    - `clearSuppression(...)` manager-only with required reason text, setting `cleared_at`, `cleared_by`, `clear_reason` and leaving communications untouched
    - `eligibleContacts(contacts, activeSuppressions, channel)` applying validation status, authorization status in Authorized/Unknown, the per-contact channel flag, and the active suppression list; exported for the scheduler and the send route
    - _Requirements: 10.10, 21.1, 21.2, 21.3, 21.4, 21.8, 21.9_

  - [x] 10.4 Write suppression tests
    - New file `src/features/cancellations/domain/__tests__/suppression.test.ts`
    - Cover: SMS opt-out setting the flag on every case holding that phone value while email stays unchanged, and the reverse; a suppressed value excluded from automatic sends, Send Reminder Now, and Retry Failed Communication with zero communication rows created; each opt-out keyword matched and a non-keyword message leaving suppression unchanged; a manager clear requiring reason text and leaving existing communications unchanged
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.8, 21.9, 25.2_

- [x] 11. Email delivery module
  - [x] 11.1 Create `src/lib/email.ts`
    - Export `isEmailConfigured(): boolean` (true only when `RESEND_API_KEY` and `CANCELLATION_EMAIL_FROM` are both present) and `sendEmail(input: { to; subject; body; senderDisplayName; replyTo }): Promise<EmailSendResult>` with `EmailSendResult = { success; messageId; failureReason; retryable }`
    - One HTTPS POST to Resend through `fetch` with a 30-second `AbortController` timeout; never throws: every provider error, non-2xx response, and timeout converts to `{ success: false, retryable }` with timeouts, 429, and 5xx retryable and other 4xx non-retryable; success stores the provider identifier unchanged, or absent when the provider returns none
    - From-address always `CANCELLATION_EMAIL_FROM`, display name from the caller, reply-to from the caller; every credential read server-side only and returned in no response body
    - Add `RESEND_API_KEY`, `CANCELLATION_EMAIL_FROM`, `CANCELLATION_EMAIL_REPLY_TO` to `.env.example` with no `NEXT_PUBLIC_` prefix; this is the only module in the repository that calls an email provider
    - _Requirements: 22.7, 23.1, 23.2, 23.4, 23.6_

  - [x] 11.2 Write email module tests
    - New file `src/lib/__tests__/email.test.ts`
    - Cover: `isEmailConfigured` false with either variable absent; a 2xx response mapping to success with the provider identifier and to success with an absent identifier when the body carries none; 429 and 500 mapped retryable; 400 and 422 mapped non-retryable; an aborted request past 30 seconds mapped to a retryable failure; a thrown network error surfacing as a failure result rather than an exception
    - _Requirements: 23.6, 23.8, 25.2_

- [x] 12. Message renderer and content gate
  - [x] 12.1 Create `src/features/cancellations/render/renderMessage.ts`
    - Pure `renderMessage(input): RenderResult` with `input = { templateVersions, cases, contact, touchpoint, channel, settings, senderName, combined }`; no I/O, no database, no provider
    - Language resolution from the included contacts' `preferred_language`, defaulting to Bilingual for absent, empty, whitespace-only, or unrecognized values; a combined message is always Bilingual
    - Bilingual assembly renders the English segment, exactly one `settings.bilingual_separator`, then the Spanish segment, each segment carrying the cancellation statement, every included effective date as day, month, and four-digit year, and the contact request with the earliest included effective date as the deadline
    - `Agency_Name` and `Office_Phone` in every body, the phone matched after stripping spaces, hyphens, parentheses, periods, and plus signs; token substitution applies `fallback_text` and renders zero characters when no fallback is stored; sender name is the assigned employee display name when present, active, not deleted, and non-blank, otherwise `Agency_Name`
    - Combined email lists every policy number with its effective date ordered by date then policy number plus the count; combined SMS states the count and the earliest date only, at most 640 characters; SMS subject renders zero characters
    - _Requirements: 11.2, 11.3, 11.6, 11.7, 11.8, 13.2, 13.3, 13.7, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.11, 14.13, 14.14, 14.15_

  - [x] 12.2 Create `src/features/cancellations/render/gate.ts` and wire it inside the renderer
    - `prohibitedPhraseMatch(text, phrases)` comparing after lower-casing both sides and collapsing whitespace runs to one space; `forbiddenTokenMatch(text)` matching `nan`, `NaN`, `None`, `null`, `undefined` only as complete tokens bounded by start, end, whitespace, or a non-alphanumeric character, treating the sequences inside longer words as compliant
    - The gate runs after assembly and before any `ok: true` return, so no caller can reach a provider on a match; `ok: false` carries `blockedBy` and the matched text
    - Callers write a `cancellation_events` block entry with the matched text, set `communication_status = 'Manual Follow-up Required'` for every included case, create zero communication rows, and continue the run
    - _Requirements: 14.8, 14.9, 14.10, 14.12_

  - [x] 12.3 Write the forbidden-token property test
    - New file `src/features/cancellations/render/__tests__/forbidden-token.property.test.ts`
    - **Property 3: No forbidden token in any rendered output**
    - Header comment `// Feature: policy-follow-up-renewals-cancellations, Property 3: For any cancellation case, contact, touchpoint, channel, and render language — including cases where the producer name, amount due, assigned employee, contact name, carrier, or cancellation reason is absent — the rendered subject and the rendered body contain none of the tokens nan, NaN, None, null, undefined as a complete token bounded by the start of the text, the end of the text, a whitespace character, or a character that is neither a letter nor a digit.`
    - `fc.assert(..., { numRuns: 100 })` minimum; each optional field independently `fc.option(...)`; language over `English | Spanish | Bilingual | undefined | '' | '  ' | 'Klingon'`; touchpoint over 15/10/5/1; channel over sms/email; combined flag with 1 to 10 included cases; customer names including `Nanette Nunez`, `Nullson`, `Undefined Holdings LLC`
    - Assert `forbiddenTokenMatch(subject) === null && forbiddenTokenMatch(body) === null` for every `ok: true` result, and that an embedded sequence inside a longer word does not block the render
    - **Validates: Requirements 14.11, 14.12, 25.6**
    - _Requirements: 14.11, 14.12, 25.6_

  - [x] 12.4 Write renderer unit tests
    - New file `src/features/cancellations/render/__tests__/render.test.ts`
    - Cover: bilingual fallback for absent, empty, whitespace-only, and unrecognized preferred language; English segment before Spanish with exactly one separator; agency name present and office phone matched after separator stripping; every included effective date rendered with day, month, four-digit year; combined email ordering by date then policy number with the count; combined SMS at most 640 characters with no policy numbers; SMS subject zero characters; a seeded prohibited phrase blocking with the matched text returned and zero communication rows
    - _Requirements: 11.2, 11.6, 11.7, 13.2, 13.3, 14.1, 14.4, 14.5, 14.8, 14.9, 14.15, 25.2_

- [x] 13. Communication status derivation and escalation
  - [x] 13.1 Create `src/features/cancellations/domain/communication-status.ts`
    - `deriveCommunicationStatus(case, contacts, communications, pendingSends, escalations)` returning the first match in the fixed nine-step order: Manual Follow-up Required, Failed, Partially Failed, Suppressed, Partially Sent, Delivered, Sent, Scheduled, Not Scheduled
    - A pending touchpoint-channel send is one scheduled touchpoint and channel with no stored communication row; case status is never derived from delivery results and delivery results never change case status
    - Also export the row-cell derivations for the SMS status cell, the email status cell, the last contact value, and the next required action, so the list and the drawer name the same action
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 16.9, 16.10_

  - [x] 13.2 Create `src/features/cancellations/domain/escalation.ts`
    - Pure `evaluateEscalations(case, contacts, communications, responses, businessDate): EscalationReason[]` returning any of No Valid Contact, All Channels Failed, SMS Suppressed Without Email, Customer Assistance Requested, No Delivered Contact, Payment Reported, Authorization Unknown
    - Each new reason upserts `cancellation_escalations` on `(case_id, reason)` so the insert path is the notification trigger and a repeated evaluation notifies once; follow-up deadline is the earlier of escalation time + 24 h and the cancellation effective date
    - Notification target is the assigned employee when present, active, and not deleted, otherwise one `public.user_notifications` row per `manager` and `super_admin` profile, all with `notification_type = 'cancellation_follow_up'`; case status left unchanged
    - `clearEscalations(caseId, actorId, note)` marking every uncleared reason cleared, clearing the follow-up deadline, and recomputing communication status
    - Runs at import completion, on every scheduler run, and after every contact change
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.8, 20.9, 20.10, 20.11, 20.12_

  - [x] 13.3 Write status and escalation tests
    - New files `src/features/cancellations/domain/__tests__/case-lifecycle.test.ts` and `escalation.test.ts`
    - Cover: each of the nine precedence steps including Manual Follow-up Required outranking Delivered and Suppressed requiring zero communication rows with every channel flag set; a delivery result reaching Sent, Delivered, or Failed leaving case status unchanged; a rejected out-of-set case status and communication status write; each of the seven escalation reasons; one notification per case and reason pair across repeated evaluations; assigned-employee versus manager fan-out; the deadline taking the earlier of +24 h and the effective date; a manual contact outcome with note text clearing every reason and recomputing status
    - Cover the payment, reinstatement, and cancelled transitions: Payment Reported from each permitted current status and rejected from Reinstated, Cancelled, Resolved, Invalid, Duplicate; the second-business-day deadline skipping Saturday, Sunday, and configured holidays and clamping to the effective date; Policy reinstated and Policy cancelled cancelling later touchpoints and retaining communications; Mark Resolved rejected outside Reinstated and Cancelled
    - _Requirements: 15.1, 15.2, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 18.1, 18.2, 18.3, 18.4, 18.8, 19.3, 19.4, 19.6, 19.7, 19.10, 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7, 20.10, 20.11, 20.12, 25.2_

- [x] 14. Notification scheduler
  - [x] 14.1 Create `src/app/api/cancellations/scheduler/route.ts`
    - `export const runtime = 'nodejs'`, `export const maxDuration = 300`; authorize by full-string equality of `Authorization: Bearer ${CRON_SECRET}`, else a session whose profile role is `manager` or `super_admin`, else HTTP 403 with zero sends and zero rows; then a service-role client from `SUPABASE_SECRET_KEY` falling back to `SUPABASE_SERVICE_ROLE_KEY`
    - Read `cancellation_settings` first: when `automatic_sending_enabled` is false, return a summary counting every candidate touchpoint as skipped with zero rows written
    - Compute the business date, select cases with `case_status in ('Imported','Open')` and `cancellation_effective_date - business_date in (15,10,5,1)`, resolve eligible contacts through `eligibleContacts`, skip a touchpoint whose due date is earlier than the business date
    - Grouping pass bucketing `(customer_match_key, normalized_value, channel)`, chunked at 10 cases per combined message in ascending effective-date order, rendered from the template version of the lowest days-remaining touchpoint in the chunk, with a null match key never joining a bucket
    - After sending, run the escalation evaluation and status recompute for every touched case and return the run summary: business date, touchpoints evaluated, sent, skipped, failed, and the skipped count per reason (existing record, due date passed, no eligible contact, excluded case status, absent email credentials)
    - When `isEmailConfigured()` is false, send zero emails, continue SMS, write zero communication rows for the skipped email keys, and report the skipped email count
    - _Requirements: 12.1, 12.2, 12.3, 12.8, 12.9, 12.10, 12.11, 12.12, 12.13, 13.1, 13.5, 13.6, 13.7, 18.2, 19.4, 19.6, 23.3, 26.5_

  - [x] 14.2 Create `src/features/cancellations/scheduler/send.ts` reserve-then-send helper
    - Insert the `cancellation_communications` row first with `delivery_result = 'Sent'` and `provider_message_id = null` to reserve the idempotency key, then call the provider, then update only `provider_message_id`, `delivery_result`, `failure_reason`, `attempt_count`, `send_time` through `cancellation_retry_communication`
    - A `23505` on the reserving insert abandons the send with no provider call, leaves the existing row untouched, and counts the key as skipped
    - SMS through `sendSms` from `src/lib/ringcentral-sms.ts`, email through `sendEmail` from `src/lib/email.ts`, with the retry policy here: at most 2 additional attempts on a retryable email failure, 5–60 s backoff, no attempt after a non-retryable result, one row carrying the final result, final failure reason, and attempt count
    - A combined message writes one communication row per included idempotency key sharing template version, subject, body, provider identifier, delivery result, and `combined_group_id`, plus one `cancellation_communication_cases` row per included case; a provider failure marks every row of the group failed with the reason and leaves every case status unchanged
    - _Requirements: 12.4, 12.5, 12.6, 12.7, 13.4, 13.8, 13.9, 14.15, 14.18, 23.4, 23.5, 23.8_

  - [x] 14.3 Write the scheduler idempotency property test
    - New file `src/features/cancellations/scheduler/__tests__/scheduler-idempotency.property.test.ts`
    - **Property 2: Scheduler idempotency across repeated runs**
    - Header comment `// Feature: policy-follow-up-renewals-cancellations, Property 2: For any set of cancellation cases with contacts, and for any run count from 2 to 5, executing the Notification_Scheduler that many times over an unchanged input produces the same set of Communication_Record rows, compared by Idempotency_Key, as the first run alone produces, and issues exactly one provider call per key in that set.`
    - `fc.assert(..., { numRuns: 100 })` minimum; a world of 1 to 12 cases with effective dates placed so touchpoints may or may not land on the fixed business date, case status drawn from all ten values, match keys from a small pool to exercise grouping, 0 to 4 contacts per channel with independent validation, authorization, and suppression; run count `fc.integer({ min: 2, max: 5 })`
    - In-memory store enforcing `unique (case_id, contact_id, touchpoint, channel)` by raising `23505`; SMS and email mocks counting calls
    - Assert `keysAfter(n) === keysAfter(1)` as sets, `providerCallCount === keysAfter(1).size`, every skipped key present in the run summary skipped total, and the same result for two scheduler instances driven alternately against one store
    - **Validates: Requirements 12.3, 12.4, 12.5, 12.6, 12.7, 25.5**
    - _Requirements: 12.3, 12.4, 12.5, 12.6, 12.7, 25.5_

  - [x] 14.4 Write scheduler unit tests
    - New file `src/features/cancellations/scheduler/__tests__/scheduler.test.ts`
    - Cover: each of the 15, 10, 5, and 1-day touchpoints firing on its due business date; a duplicate run on the same date sending nothing and counting skips; SMS success and SMS failure recorded on the reserved row; email success and email failure with the attempt count; a case with no eligible contact skipped with its reason; an excluded case status skipped; a due date in the past skipped; two cases for one customer on one contact value rendering one combined message with one row per key; the kill switch off producing all-skipped counts and zero rows; absent email credentials writing zero email rows while SMS continues
    - _Requirements: 12.1, 12.2, 12.5, 12.8, 12.12, 12.13, 13.1, 13.4, 14.18, 23.3, 26.5, 25.2_

  - [x] 14.5 Write the provider isolation test
    - New file `src/features/cancellations/__tests__/provider-isolation.test.ts`
    - Assert every send path resolves `sendSms` and `sendEmail` to mocks during the test run and that the real `src/lib/ringcentral-sms.ts` and `src/lib/email.ts` fetch paths record zero calls; assert no module outside `src/lib/email.ts` references the email provider endpoint or `RESEND_API_KEY`
    - _Requirements: 23.1, 23.5, 25.3_

- [ ] 15. Manual send route
  - [x] 15.1 Create `src/app/api/cancellations/send/route.ts`
    - `Send Reminder Now`: current touchpoint is the latest scheduled date not after the business date, else the 15-day touchpoint; sends to every contact of the case that is valid, authorized, and not suppressed on that channel through the 14.2 helper; skips a key whose existing row is not failed and reports it as already sent; returns sent, skipped, and failed counts
    - `Retry Failed Communication`: manager or `super_admin` only, targets only contacts whose row for the current touchpoint and channel is failed, updates that row through `cancellation_retry_communication` instead of inserting a second row, leaves template version, subject, and body unchanged, and appends one retry entry per contact and channel to `cancellation_events`
    - Zero eligible contacts on the target channel returns an error naming the requirement for valid authorized contact information with zero rows written and case status unchanged; both actions work while `automatic_sending_enabled` is false
    - _Requirements: 17.5, 17.6, 17.11, 17.12, 21.3, 21.4, 22.2, 22.6, 26.6_

  - [ ] 15.2 Write send route tests
    - New file `src/features/cancellations/scheduler/__tests__/send-route.test.ts`
    - Cover: current touchpoint selection including the pre-15-day fallback; an existing non-failed row skipped with the already-sent indication; retry updating the existing row with a new send time, provider identifier, and result while subject and body stay byte-identical; zero eligible contacts returning the error with no rows written; both actions succeeding while the kill switch is off; a non-manager retry rejected with 403
    - _Requirements: 17.5, 17.6, 17.11, 17.12, 22.6, 26.6, 25.2_

- [ ] 16. Cancellations UI
  - [x] 16.1 Create `src/features/cancellations/api.ts`
    - The single data-access module for the Cancellations tab: case list paged at 50 rows in the Requirement 16.5 sort order, case detail, contacts, communications with their linked cases, events, notes, customer responses, payment reports, verification outcomes, escalations, import runs, templates, settings
    - Writes for contact creation and edits, preferred language, authorization, opt-out and clear, notes with evidence, customer responses, payment reports, verification outcomes, case status override with reason, assignment, and the settings kill switch; evidence uploads to `cancellation-evidence` with signed-URL download only
    - Every Supabase call for the Cancellations tab lives here; no credential value is returned to the browser
    - _Requirements: 16.5, 22.1, 22.4, 22.7, 22.9_

  - [x] 16.2 Create `src/features/cancellations/derive.ts`
    - Pure helpers: `daysRemaining` from the business date, the thirteen row cells with em dash and `Unassigned` rules, `matchesSavedFilter` for the fourteen filters with `active` defined as Imported, Open, Payment Reported, Verification Pending, Reinstatement Pending, `matchesSearch` (trim, 100-character cap, case-insensitive substring over customer name, policy number, carrier, contact phone and email including invalid and suppressed contacts, digit-only comparison when the search text contains a digit), `compareCancellationRows` (effective date ascending, amount due descending with absent last, customer name, policy number), and `primaryAction` implementing the eight-step ordered rule with role visibility applied first
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.7, 16.8, 16.9, 17.4_

  - [x] 16.3 Write cancellations derive tests
    - New file `src/features/cancellations/__tests__/derive.test.ts`
    - Cover: days remaining 0 on the effective date and negative before it; each of the fourteen saved filter matching rules with Needs Action as the default; the digit-only phone search path; the four-key sort producing a total order with absent amount due last; each of the eight primary-action steps including a step skipped because the control is hidden from `agent`
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.7, 16.8, 17.4, 25.2_

  - [x] 16.4 Create `src/features/cancellations/CancellationsSummaryBar.tsx`
    - Renders the fourteen saved filters with counts from props, exactly one active with Needs Action selected until the user picks another, a search field, and the empty-state variants: filter-and-search naming both with a control clearing both, and the no-filter no-search variant without that control
    - _Requirements: 16.2, 16.3, 1.4, 1.6, 1.9_

  - [x] 16.5 Create `src/features/cancellations/CancellationsTable.tsx`
    - Renders the thirteen cells per row in the Requirement 16.1 order from props, pages of at most 50 rows, a loading indicator for the first page, and row click opening the drawer for that case with at most one drawer displayed
    - _Requirements: 16.1, 16.5, 16.6, 16.9, 16.10, 1.5_

  - [ ] 16.6 Create `src/features/cancellations/CancellationDrawer.tsx`
    - Renders the customer and policy summary, carrier, effective date, reason, amount due, assigned employee, every contact row with channel, normalized value, validation status, both suppression states, authorization status and primary status, preferred language, the four-touchpoint schedule with per-channel send state, SMS and email delivery history most recent first, recorded customer responses, notes and evidence, next required action, case status, communication status, and the audit timeline ordered by event time then insertion order, most recent first
    - Hosts the nine controls as individually selectable actions with exactly one rendered prominent per `primaryAction`; hides Verify Payment, Confirm Reinstatement, Confirm Cancellation, and Retry Failed Communication from Agent_Role and shows all nine to `manager` and `super_admin`
    - Shows the combined-message coverage ("this notice covers N policies") from `cancellation_communication_cases` for every case in a group
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.7, 17.10, 17.12, 13.8_

  - [ ] 16.7 Write drawer role-visibility tests
    - New file `src/features/cancellations/__tests__/drawer-controls.test.ts`
    - Cover: the four manager-only controls absent for `agent`, `customer_service`, `sales_supervisor` and present for `manager` and `super_admin`; exactly one prominent control rendered for each primary-action step; the timeline ordering on equal event times
    - _Requirements: 17.3, 17.4, 17.7, 17.10, 22.2, 22.3, 25.2_

  - [x] 16.8 Create `src/features/cancellations/CancellationContactPanel.tsx`
    - Add contact information (phone or email) through the same normalization and validation helpers as the importer, edit preferred language restricted to English, Spanish, Bilingual with a rejection naming the three values and the stored value retained, set authorization status, record SMS and email opt-out, and record a customer response with one of the six response types, a note of at most 2,000 characters and at least one non-whitespace character for Assistance requested and Other
    - Assistance requested and Callback requested set the case assistance flag and feed the Customer Assistance Requested escalation; every change writes the previous value, new value, profile, and time to `cancellation_events` and triggers the escalation re-evaluation; existing communications are never modified
    - _Requirements: 10.9, 11.1, 11.5, 20.4, 21.1, 21.2, 21.5, 21.6, 21.7, 22.2_

  - [ ] 16.9 Create `src/features/cancellations/CancellationPaymentReport.tsx`
    - Records a payment report with required note text of 1 to 2,000 trimmed characters, optional amount from 0.01 to 999,999,999.99, optional confirmation reference of at most 100 characters, and zero or more evidence files at 10 files and 100 MB each
    - On success sets case status Payment Reported, next required action Verify Payment, and the follow-up deadline to the end of the second business day excluding weekends and configured holidays, clamped to the effective date; adds one timeline entry and leaves every communication row unchanged
    - Rejects an empty note, an out-of-range amount, an over-length reference, an oversized or failed evidence upload, and a case already Reinstated, Cancelled, Resolved, Invalid, or Duplicate, in each case naming the rejected field or the closed-case reason, storing nothing and leaving case status and deadline unchanged
    - _Requirements: 18.1, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 18.10_

  - [ ] 16.10 Create `src/features/cancellations/CancellationVerificationPanel.tsx`
    - Manager and `super_admin` only: records one of the seven verification outcomes with the recording profile, verification time, note, and evidence, and adds the outcome to the timeline
    - Policy reinstated sets Reinstated, Policy cancelled sets Cancelled, both cancelling every later touchpoint, clearing the next required action, and retaining every communication row; Payment verified — reinstatement pending sets Reinstatement Pending with next action Confirm Reinstatement and a deadline no later than three business days, sending stays suspended; Payment not found, Additional payment required, Policy still scheduled for cancellation, and Other each require note text plus a next case status from Open, Verification Pending, Cancelled plus a next required action, rejecting an incomplete submission with the entered values retained
    - Mark Resolved requires current status Reinstated or Cancelled plus note text, otherwise rejected with the reason; a case status override requires reason text of 1 to 1,000 characters stored with the profile, time, previous and new status as one timeline entry; a non-manager attempt is rejected with the role message and no change
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.7, 19.8, 19.9, 19.10, 19.11, 22.4, 22.10, 22.11_

  - [ ] 16.11 Create `src/features/cancellations/CancellationManagerActions.tsx`
    - Manager and `super_admin` only, one collapsed control hosting the import wizard (upload, classification result, mapping overrides, the five preview counts with rejected, duplicate, and unmatched lists, confirmation calling the loader, and the completion summary), template editing that saves a new version rather than updating one, the automatic-sending kill switch with the profile and change time stored, unmatched producer and customer review, reassignment, and imported-data correction
    - Renders nothing at all for Agent_Role rather than a disabled control
    - _Requirements: 8.1, 8.4, 8.5, 14.17, 22.3, 26.4_

  - [ ] 16.12 Create `src/features/cancellations/CancellationsPage.tsx` and wire the tab
    - Page container owning records, load, error, retry, search text, saved filter, sort order, selected case id, and the business date computed once per render pass; composes the summary bar, table, drawer, contact panel, payment report, verification panel, and manager actions; hosts the note composer requiring 1 to 4,000 trimmed characters with the 10-file and 100 MB evidence limits
    - Replaces the placeholder in `PolicyFollowUpPage.tsx` with this container, keeping the per-tab state retention, the drawer close on tab leave, and the failed-query retry behavior
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 1.7, 1.10, 17.1, 17.8, 17.9_

- [ ] 17. Role enforcement and audit immutability tests
  - [ ] 17.1 Write RLS role-enforcement tests
    - New file `src/features/cancellations/__tests__/rls-role-enforcement.test.ts`
    - Cover per role (`agent`, `customer_service`, `sales_supervisor`, `manager`, `super_admin`): case read scope; write limited to rows assigned to self; the four case status values an Agent_Role profile may set and the rejection of every other value including any change on a closed case; verification outcome insert denied outside Manager_Role; import run read denied to `agent`; manager-only operations returning 403 and leaving data unchanged; `super_admin` matching `manager` on every check
    - _Requirements: 19.11, 22.1, 22.2, 22.3, 22.6, 22.9, 22.10, 22.12, 25.2_

  - [ ] 17.2 Write the audit immutability integration test
    - New file `src/features/cancellations/__tests__/audit-immutability.integration.test.ts`, run by `npm run test:integration`
    - Attempt update and delete on `cancellation_communications` and `cancellation_events` as `agent`, as `manager`, and through a service-role client; assert every attempt fails with the immutability error and the row is byte-identical afterwards; assert `cancellation_retry_communication` updates only the five permitted columns and rejects a subject or body change
    - _Requirements: 14.16, 17.7, 22.8, 25.2_

- [ ] 18. Scheduler authorization tests
  - [ ] 18.1 Write scheduler auth tests
    - New file `src/features/cancellations/__tests__/scheduler-auth.test.ts`
    - Cover: no `Authorization` header, a wrong bearer token, a token that is a prefix or suffix of the configured secret, and a session whose role is not `manager` or `super_admin` all returning HTTP 403 with zero communication rows created and zero provider calls; the exact bearer token and a `manager` session and a `super_admin` session each authorized
    - _Requirements: 12.9, 12.10, 22.6, 25.7_

- [x] 19. Phase 2 verification gate and commit
  - [x] 19.1 Phase 2 verification gate — one run, four results
    - In a single verification run execute, in order, `npx tsc --noEmit`, then `npm test`, then `npm run test:integration`, then `npm run build`
    - Record all four outcomes plus the run identifier in the Verification Record section, and confirm the run contains a passing case for every item named in Requirement 25 criteria 2 through 7; any non-zero error count or failing test voids the record and the whole sequence is re-run after the fix
    - _Requirements: 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.9_

  - [x] 19.2 Commit Phase 2
    - Stage only the Phase 2 paths (`supabase/migrations/v1.10.*`, `src/features/cancellations/**`, `src/lib/email.ts`, `src/lib/__tests__/email.test.ts`, `src/app/api/cancellations/**`, `src/features/renewals/PolicyFollowUpPage.tsx`, `.env.example`, this tasks file) by name, leaving the unrelated changes from 0.1 unstaged
    - Commit with the title `feat(cancellations): add reminder and tracking workflow`, producing exactly two commits on `feature/renewals-cancellations`
    - _Requirements: 26.7_

---

## Notes

- No test task is marked optional. Requirement 25 makes the named test set part of both verification gates (25.8, 25.9), so skipping a test task voids the gate it feeds.
- The three correctness properties are tasks 8.2 (Property 1), 14.3 (Property 2), and 12.3 (Property 3). Each is one `fast-check` test at `numRuns: 100` minimum, carrying the header comment form `// Feature: policy-follow-up-renewals-cancellations, Property {n}: {property text}`.
- Deployment, environment-variable configuration in Vercel, cron registration, and rollback stay in `design.md`. Requirement 26.8 makes deployment a manual manager action, so no task here deploys anything.
- Phase 1 touches no migration, no RPC, no table, no column, and no storage bucket. Every Phase 1 write goes through the eight existing renewal functions via `src/features/renewals/api.ts`.
- Phase 2 migrations are forward-only in the v1.10.x series. No file at v1.9.7 or earlier is edited, and no statement drops or truncates anything created at v1.9.7 or earlier.

## Defect Log (Requirement 2.6)

Any defect found in existing renewal business logic during Phase 1 is recorded here with the affected database function or feature file, the observed behavior, and the expected behavior. The listed function stays unchanged until a `manager` or `super_admin` profile approves the entry. A capability reachable only through a direct table write or a replacement function is recorded here and left outside the revision (Requirement 2.10).

| # | Function or file | Observed | Expected | Approved by |
| --- | --- | --- | --- | --- |
| _(none recorded)_ | | | | |

## Verification Record

**Pre-branch working tree (task 0.1):** recorded 2026-08-02T16:27:47Z · branch `main` · HEAD `8e18224e5c25c7d4a0bad560a1d2825837609fbd`. The working tree is **not** clean. `git status --porcelain -uall` reports 13 paths, all under `.kiro/specs/` and all unrelated to this spec's implementation:

| Status | Path |
| --- | --- |
| ` M` | `.kiro/specs/time-attendance-ui-redesign/tasks.md` |
| ` M` | `.kiro/specs/time-attendance-ui-redesign/tasks.meta.json` |
| `??` | `.kiro/specs/policy-follow-up-renewals-cancellations/.config.kiro` |
| `??` | `.kiro/specs/policy-follow-up-renewals-cancellations/design.md` |
| `??` | `.kiro/specs/policy-follow-up-renewals-cancellations/requirements.md` |
| `??` | `.kiro/specs/policy-follow-up-renewals-cancellations/tasks.md` |
| `??` | `.kiro/specs/policy-follow-up-renewals-cancellations/tasks.meta.json` |
| `??` | `.kiro/specs/rc-claim-duplicate-quote-fix/.config.kiro` |
| `??` | `.kiro/specs/rc-claim-duplicate-quote-fix/bugfix.md` |
| `??` | `.kiro/specs/rc-claim-duplicate-quote-fix/design.md` |
| `??` | `.kiro/specs/rc-claim-duplicate-quote-fix/tasks.md` |
| `??` | `.kiro/specs/rc-claim-duplicate-quote-fix/tasks.meta.json` |

(Collapsed `git status --porcelain` form of the same state: ` M .kiro/specs/time-attendance-ui-redesign/tasks.md`, ` M .kiro/specs/time-attendance-ui-redesign/tasks.meta.json`, `?? .kiro/specs/policy-follow-up-renewals-cancellations/`, `?? .kiro/specs/rc-claim-duplicate-quote-fix/`.)

Protected-path check — **zero** of the 13 paths is inside `src/features/renewals`, `src/app/tools/renewals`, `src/platform/module-registry.ts`, or `supabase/migrations`. None of them can be mistaken for Phase 1 work; all 13 stay unstaged and out of both Phase commits (Requirement 26.7). (The table above enumerates 12 distinct paths; the "13" count in this record is a tally slip in 0.1 and does not change the path list or the protected-path result.)

**Post-branch working tree (task 0.2):** `git switch -c feature/renewals-cancellations` created the branch off `main` at HEAD `8e18224e5c25c7d4a0bad560a1d2825837609fbd` with no stash, no checkout of tracked files, and no `git add`. `git branch --show-current` reports `feature/renewals-cancellations`; `git rev-parse HEAD` is unchanged at `8e18224e5c25c7d4a0bad560a1d2825837609fbd`. `git status --porcelain` after the switch is byte-for-byte identical to the collapsed list recorded in 0.1:

```
 M .kiro/specs/time-attendance-ui-redesign/tasks.md
 M .kiro/specs/time-attendance-ui-redesign/tasks.meta.json
?? .kiro/specs/policy-follow-up-renewals-cancellations/
?? .kiro/specs/rc-claim-duplicate-quote-fix/
```

`git status --porcelain -uall` expands to the same 12 paths listed in the 0.1 table, and `git diff --cached --name-only` is empty, so nothing is staged and neither Phase commit can pick these changes up (Requirement 26.7).

### Phase 1 line budget (task 6.1) — Requirement 7.6 · PASS

Measured 2026-08-02 on branch `feature/renewals-cancellations`. Pre-Phase-1 commit = current `HEAD` = `8e18224e5c25c7d4a0bad560a1d2825837609fbd` (Phase 1 is still uncommitted, so `HEAD` is the pre-revision tree; `PowerBiRenewalImport.tsx` shows as ` D` in `git status` and is read from the commit).

**Counting command — identical on both sides.** `wc -l` (newline-count semantics) from Git for Windows (`C:\Program Files\Git\usr\bin\wc.exe`), invoked through `bash`:

```bash
# baseline (file deleted from the working tree, so read from the commit)
git show 8e18224e5c25c7d4a0bad560a1d2825837609fbd:src/features/renewals/RenewalsPage.tsx | wc -l
git show 8e18224e5c25c7d4a0bad560a1d2825837609fbd:src/features/renewals/PowerBiRenewalImport.tsx | wc -l

# post-revision
wc -l < src/features/renewals/<file>.tsx
```

PowerShell `Measure-Object -Line` was **not** used on either side: it drops blank lines and under-reports, which would make the two sides non-comparable.

**Baseline — 2,740 lines**

| Lines | File (at `8e18224`) |
| ---: | --- |
| 1,623 | `src/features/renewals/RenewalsPage.tsx` |
| 1,117 | `src/features/renewals/PowerBiRenewalImport.tsx` |
| **2,740** | **baseline total** |

**Post-revision — 2,739 lines** (the six Requirement 7.1 components plus the renewals page container, which is exactly the set Requirement 7.6 scopes)

| Lines | File |
| ---: | --- |
| 89 | `src/features/renewals/RenewalsSummaryBar.tsx` |
| 192 | `src/features/renewals/RenewalsTable.tsx` |
| 161 | `src/features/renewals/RenewalTimeline.tsx` |
| 688 | `src/features/renewals/RenewalContactComposer.tsx` |
| 519 | `src/features/renewals/RenewalDrawer.tsx` |
| 730 | `src/features/renewals/RenewalManagerActions.tsx` |
| 360 | `src/features/renewals/RenewalsPage.tsx` (container) |
| **2,739** | **post-revision total** |

**Result: 2,739 ≤ 2,740 — Requirement 7.6 satisfied with 1 line of headroom.** No source file was reduced; nothing needed to be cut before the 6.2 gate. Both per-file sums were cross-checked against a single `wc -l` over the concatenated content (`{ git show …; git show …; } | wc -l` = 2,740 and `cat <seven files> | wc -l` = 2,739), so the totals are not a per-file addition artifact.

Because the margin is one line, the trailing-newline edge case was checked explicitly: all nine measured files (both baseline blobs and all seven post-revision files) end with a newline byte, so `wc -l` equals the visible line count on both sides and the result does not depend on newline-termination semantics.

**Requirement 7.4 — no renewal UI component file outside the six.** `src/features/renewals` holds eight `.tsx` files; `PowerBiRenewalImport.tsx` is deleted (task 4.1) and no `*powerbi*` file remains anywhere under `src`:

| File | Classification |
| --- | --- |
| `RenewalsSummaryBar.tsx` | one of the six (Req 7.1) |
| `RenewalsTable.tsx` | one of the six (Req 7.1) |
| `RenewalTimeline.tsx` | one of the six (Req 7.1) |
| `RenewalContactComposer.tsx` | one of the six (Req 7.1) |
| `RenewalDrawer.tsx` | one of the six (Req 7.1) |
| `RenewalManagerActions.tsx` | one of the six (Req 7.1) |
| `RenewalsPage.tsx` | page container — named separately from the six by Req 7.6 ("the six components … together with the renewals page container"); pre-existing file rewritten in place, not created |
| `PolicyFollowUpPage.tsx` (133 lines) | Policy_Follow_Up_Workspace tab shell required by Req 1.1 and task 5.2 |

Non-`.tsx` modules in the directory (`api.ts`, `derive.ts`, `format.ts`, `timeline.ts`) are not UI component files and are outside both Req 7.4 and the Req 7.6 budget. No renewal UI component file exists anywhere else under `src`; the only other `.tsx` files touching this feature are `src/app/tools/policy-follow-up/page.tsx` (route, task 5.3), `src/app/tools/renewals/page.tsx` (redirect, task 5.4), the `__tests__` files, and the pre-existing unmodified `src/components/role-workspace.tsx`, which imports `RenewalsPage` as a consumer.

**Reading of Requirement 7.4 applied here, stated explicitly:** 7.4 is read as **not** covering `PolicyFollowUpPage.tsx`. Its subject is THE Renewals_Module and its scope is the *renewal* component list of 7.1, whereas `PolicyFollowUpPage.tsx` is the Policy_Follow_Up_Workspace shell that the glossary keeps distinct from the Renewals_Module, that Requirement 1.1 mandates, and that task 5.2 explicitly instructs to create at that path; `design.md` likewise places it above `RenewalsPage.tsx` in the component tree and scopes the line budget to "the six components plus the page container", excluding it. A reading that let 7.4 forbid it would put Requirement 7.4 in direct conflict with Requirement 1.1 and task 5.2. `RenewalsPage.tsx` is likewise not covered: Req 7.6 names it separately from the six, and it was rewritten rather than created. The only thing that gives the strict reading any pull is the file's *location* inside `src/features/renewals`; if that residual ambiguity is unwelcome, moving the shell to its own directory (for example `src/features/policy-follow-up/PolicyFollowUpPage.tsx`) would remove the appearance of conflict, but that is a scope change and was not made here. Neither file counts toward the 2,739 total, and including `PolicyFollowUpPage.tsx` would raise the total to 2,872 and exceed the 2,740 baseline — so this reading is load-bearing for the 7.6 result and is recorded here rather than left implicit.

### Phase 1 gate (task 6.2) — Requirements 7.3, 7.5, 25.1, 25.8 · PASS

**Run identifier:** `2026-08-03T00:38:59Z` UTC (sequence completed `2026-08-03T00:40:12Z` UTC) · `git rev-parse HEAD` = `8e18224e5c25c7d4a0bad560a1d2825837609fbd` · branch `feature/renewals-cancellations`.

`HEAD` was re-read after the third command and is unchanged, so all three results come from one tree state, as Requirement 7.3 demands ("all three of those results produced in that same verification run"). Phase 1 is still uncommitted at this gate, so `HEAD` is the pre-revision commit and the measured tree is `HEAD` plus the unstaged Phase 1 working tree.

**The three outcomes, in execution order:**

| # | Command | Result |
| --- | --- | --- |
| 1 | `npx tsc --noEmit` | **0 errors** — exit code 0, zero output lines matching `: error TS` |
| 2 | `npm test` (`vitest --run`) | **Test Files 72 passed \| 1 skipped (73)** · **Tests 1215 passed \| 13 skipped (1228)** — exit code 0, **0 failed** in both tallies |
| 3 | `npm run build` | **`✓ Compiled successfully in 2.4s`** — exit code 0, 0 build errors |

There is no `typecheck` script in `package.json`, so the type check is `npx tsc --noEmit` as the task specifies.

**Zero of the three results is attributable to this spec.** Per-path counts inside the paths this spec owns:

| Path | Type errors | Failing tests | Build errors |
| --- | ---: | ---: | ---: |
| `src/features/renewals` | 0 | 0 (166 test cases across 7 files, all passing) | 0 |
| `src/features/cancellations` | 0 | 0 | 0 |
| `src/app/tools/policy-follow-up` | 0 | 0 | 0 (`/tools/policy-follow-up` present in the route manifest) |
| `src/app/tools/renewals` | 0 | 0 | 0 (`/tools/renewals` present in the route manifest, serving the 5.4 redirect) |
| `src/platform/module-registry.ts` | 0 | 0 | 0 |
| **Total attributable to this spec** | **0** | **0** | **0** |

`src/features/cancellations` does not exist yet — Phase 2 (task 8.1 onward) creates it — so its zeros are vacuous by construction, recorded here for completeness. The seven renewals test files are `derive.test.ts`, `renewal-actions.test.tsx`, `renewal-evidence.test.tsx`, `renewal-manager-actions.test.tsx`, `renewal-permissions.test.tsx`, `renewal-timeline.test.ts`, `renewals-table.test.tsx`; every one of their 166 reported test cases carries a pass marker and none carries a fail or skip marker.

**The 1 skipped test file is not a failure.** It is `src/features/time-attendance/server/__tests__/audit-immutability.integration.test.ts`, which owns all 13 skipped test cases. Its own header records why: it needs the live project and "self-skips unless the Supabase Management API credentials are in the environment", and `npx vitest --run` does not read `.env.local`, so the default suite reports these as skipped and stays offline; it runs under `npm run test:integration`. This is pre-existing, belongs to the `time-attendance` work, and is a skip rather than a failure — Requirements 7.3, 7.5, and 25.8 gate on **failing** tests ("zero failing test cases"), and the run reports zero of those.

**Anticipated exception that did not materialize — `src/features/cs-intake/__tests__/quote-visibility-bug-exploration.test.ts`.** This gate was authorized to record PASS scoped to this spec with this file failing as a documented exception. That exception turned out to be unnecessary: **the file passes on this tree, 7 of 7 test cases.** Recorded so the discrepancy is not read as an omission:

- The file's header states: `On UNFIXED code, these tests MUST FAIL — failure confirms the bug exists.` and `DO NOT attempt to fix the test or the code when it fails.`
- Its owning spec is `cs-intake-quote-visibility` (declared in its own header line `// Feature: cs-intake-quote-visibility, Property 1: Bug Condition - Quote Visibility Missing for Converted Intakes`).
- It was **not touched** in this task — not the test, not the code it exercises. Its passing state is the pre-existing state of the tree at `8e18224`, which by the file's own logic means the `cs-intake-quote-visibility` fix is already applied here. Confirming that is that spec's business, not this gate's.
- User authorization to proceed to Phase 2 with this file failing was granted in advance and is therefore unused. The gate stands on zero failing tests overall, not on a scoped exception.

**Edit made to satisfy check 1 — not Phase 1 work.** Four `TS2322` errors stood in the way of a zero-error type check, all of them in another spec's test files and none in any path this spec owns:

| File | Line | Error |
| --- | ---: | --- |
| `src/features/cs-intake/__tests__/rc-claim-bug-condition.test.ts` | 72 | `TS2322` — `fc.record` result not assignable to `fc.Arbitrary<CsIntakeSubmission>` |
| `src/features/cs-intake/__tests__/rc-claim-preservation.test.ts` | 157, 213, 269 | `TS2322` — same, three arbitraries |

Each `fc.record(...)` omitted 26 of the required properties of `CsIntakeSubmission` (`insured_middle_name`, `is_walk_in`, and the trucking, commercial GL, homeowners, non-owners, and commercial-card extension blocks), so the arbitrary it produced was not assignable to the annotated `fc.Arbitrary<CsIntakeSubmission>`. A test-only typing defect: the arbitraries were written against an older shape of the interface.

The fix completes each arbitrary. A single `unreadSubmissionColumnArbs` object per file supplies the 26 missing properties, each pinned with `fc.constant` to its absent/default value (`null`, or `false` for the two non-nullable booleans `is_walk_in` and `prior_claims`), and is spread into the four `fc.record` calls. **No test assertion was changed, removed, or weakened, and no `any` cast or `@ts-expect-error` was used** — the four arbitraries generate exactly the same values for every field any assertion reads, and the added fields are read by no assertion and by none of the simulated state transitions in either file. `rc-claim-bug-condition.test.ts` and `rc-claim-preservation.test.ts` both pass after the edit. These two files belong to the `rc-claim-duplicate-quote-fix` spec, live outside every path listed in the per-path table above, and are recorded here so the edit is not mistaken for Phase 1 work when task 6.3 stages Phase 1 by name.

**Requirement 7.5 check:** no result in this run is non-zero on errors or failures, so no earlier validated record is voided and no re-run is owed. Requirement 7.3 is satisfied — one run, three results, each named with its outcome and the run identifier recorded above — and Phase 2 (task 7.1 onward) is unblocked once task 6.3 commits Phase 1.

### Phase 2 gate (task 19.1) — Requirements 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.9 · PASS

**Run identifier:** `2026-08-03T13:04:26Z` UTC (sequence completed `2026-08-03T13:05:18Z` UTC) · `git rev-parse HEAD` = `ffb39b51086f4b35ea0839d78046016e6d1b7699` · branch `feature/renewals-cancellations`.

`HEAD` was read immediately before the first command and again immediately after the fourth: `ffb39b51086f4b35ea0839d78046016e6d1b7699` both times, branch `feature/renewals-cancellations` both times. All four results therefore come from one tree state, as Requirement 25.9 demands. Phase 2 is still uncommitted at this gate, so `HEAD` is the post-Phase-1 commit and the measured tree is `HEAD` plus the unstaged Phase 2 working tree.

**The four outcomes, in execution order:**

| # | Command | Result |
| --- | --- | --- |
| 1 | `npx tsc --noEmit` | **0 errors** — exit code 0, zero output lines of any kind, zero lines matching `: error TS` |
| 2 | `npm test` (`vitest --run`) | **Test Files 97 passed \| 2 skipped (99)** · **Tests 2197 passed \| 38 skipped (2235)** — exit code 0, **0 failed** in both tallies; 549 of 549 suites passed, 0 failed |
| 3 | `npm run test:integration` | **Test Files 2 passed (2)** · **Tests 38 passed (38)** — exit code 0, **0 failed**, 0 skipped; connected to the live Supabase project through `--env-file=.env.local` |
| 4 | `npm run build` | **`✓ Compiled successfully in 2.6s`** — exit code 0, 0 build errors; `/api/cancellations/scheduler` and `/api/cancellations/send` both present in the route manifest |

There is no `typecheck` script in `package.json`, so the type check is `npx tsc --noEmit` as the task specifies.

**Reporter flags, stated so the invocation is not misread.** Commands 2 and 3 were invoked as `npm test -- --reporter=default --reporter=json --outputFile.json=…` and `npm run test:integration -- --reporter=default --reporter=json --outputFile.json=…`. The appended flags add a machine-readable per-test report and change no test selection, no filter, and no configuration; the attribution tables below are read from those reports, so every count in them comes from this run rather than from a reading of the source. Cross-check: `npm test` had already been run in this sitting in its bare form and reported the identical tallies (97 passed | 2 skipped files, 2197 passed | 38 skipped tests), so the reporter flags demonstrably did not alter the executed set.

**No source file was modified for this gate.** Every check passed on the first attempt, so nothing was fixed, nothing was re-run, and no Defect Log entry is owed.

**Zero of the four results is attributable to this spec — or to anything else.** Per-path counts inside the paths this spec owns:

| Path | Type errors | Failing tests | Build errors | Passing test cases |
| --- | ---: | ---: | ---: | ---: |
| `src/features/cancellations` | 0 | 0 | 0 | 964 across 25 files (939 under `npm test`, 25 under `npm run test:integration`) |
| `src/lib/email.ts` (via `src/lib/__tests__/email.test.ts`) | 0 | 0 | 0 | 43 across 1 file |
| `src/app/api/cancellations` | 0 | 0 | 0 | both routes in the build manifest; exercised by `send-route.test.ts` (37) and `scheduler-auth.test.ts` (31) |
| `supabase/migrations/v1.10.*` | 0 | 0 | 0 | 10 files; asserted live by `audit-immutability.integration.test.ts` (25) and scanned by `rls-role-enforcement.test.ts` (54) |
| `src/features/renewals` (Phase 1, re-checked) | 0 | 0 | 0 | 166 across 7 files |
| **Total attributable to this spec** | **0** | **0** | **0** | |

**Requirement 25.2 — a passing case for every one of the 25 named items.** Every row below ran and passed in **this** run:

| # | Named item | Passing test | File · count |
| --- | --- | --- | ---: |
| 1 | `eficacia` CSV format | `classifyImportFile: the eficacia column set (Req 8.2)` (4) plus `parseClassifiedRow` legacy-value cases | `import/__tests__/import-classify.test.ts` · 6 |
| 2 | `avisos` CSV format | `classifyImportFile: the avisos column set (Req 8.3)` (3) plus `parseClassifiedRow` avisos cases | `import/__tests__/import-classify.test.ts` · 6 |
| 3 | multiple contacts in one cell | `splitContactCell (Req 10.1, 10.2, 10.3)` (3) and `buildChannelContacts: one row per segment` (5) | `import/__tests__/contact-normalization.test.ts` · 8 |
| 4 | invalid contacts | `normalizePhoneSegment: no matching form (Req 10.11)` (9), `emailValidationFailures` (12), `buildChannelContacts: invalid rows are retained and counted` (3) | `import/__tests__/contact-normalization.test.ts` · 25 |
| 5 | duplicate rows | `buildImportPreview: two rows sharing one identity (Req 9.4)` and `re-importing the byte-identical file (Req 24.5)` (5) | `import/__tests__/import-preview.test.ts` · 11 |
| 6 | multiple policies for one customer | `runScheduler — a combined multi-policy message (Requirements 13.1, 13.4)` (1), `sendCommunication — combined multi-policy message` (3), combined-render cases (15) | `scheduler/__tests__/scheduler.test.ts`, `scheduler/__tests__/send.test.ts`, `render/__tests__/render.test.ts` · 19 |
| 7 | 15-day Touchpoint | `sends the 15-day Touchpoint on its due business date, one message per channel` | `scheduler/__tests__/scheduler.test.ts` · 1 |
| 8 | 10-day Touchpoint | `sends the 10-day Touchpoint on its due business date, one message per channel` | `scheduler/__tests__/scheduler.test.ts` · 1 |
| 9 | 5-day Touchpoint | `sends the 5-day Touchpoint on its due business date, one message per channel` | `scheduler/__tests__/scheduler.test.ts` · 1 |
| 10 | 1-day Touchpoint | `sends the 1-day Touchpoint on its due business date, one message per channel` | `scheduler/__tests__/scheduler.test.ts` · 1 |
| 11 | bilingual fallback | `resolveRenderLanguage (Requirements 11.2, 11.3, 11.8)` (11) and `renderMessage language resolution (Requirement 11.2)` | `render/__tests__/render.test.ts` · 49 |
| 12 | duplicate scheduler execution | `runScheduler — a duplicate run on the same business date (Requirement 12.5) > sends nothing on the second run and counts every key as an existing record` (1) plus Property 2 (2) | `scheduler/__tests__/scheduler.test.ts`, `scheduler/__tests__/scheduler-idempotency.property.test.ts` · 3 |
| 13 | SMS success | `records an accepted SMS on the row it reserved, with zero characters as the subject` | `scheduler/__tests__/scheduler.test.ts` · 1 |
| 14 | SMS failure | `records a refused SMS as one failed row and leaves Case_Status untouched` | `scheduler/__tests__/scheduler.test.ts` · 1 |
| 15 | email success | `records an accepted email with the provider identifier and the rendered subject` plus `src/lib/__tests__/email.test.ts` | `scheduler/__tests__/scheduler.test.ts` · 1 (+43) |
| 16 | email failure | `stores the final failure of three attempts as the attempt count on one row` (1) and `sendCommunication — email retry policy (Requirement 23.8)` (4) | `scheduler/__tests__/scheduler.test.ts`, `scheduler/__tests__/send.test.ts` · 5 |
| 17 | missing contact information | `skips a case with no eligible Contact_Recipient, per channel, with zero rows` | `scheduler/__tests__/scheduler.test.ts` · 1 |
| 18 | customer opt-out | `suppressChannel: SMS opt-out … (Req 21.1)` (5), `suppressChannel: email opt-out … (Req 21.2)` (2), `recordInboundOptOut (Req 21.8)` (15), `matchesOptOutKeyword (Req 21.8)` (17), `a suppressed value sends nothing on any path (Req 21.3, 21.4)` (7) | `domain/__tests__/suppression.test.ts` · 109 |
| 19 | customer response | `records an assistance response with the pending-send count and reports the escalation as due`, `requires non-blank note text for Assistance requested and stores nothing`, `Customer Assistance Requested (Requirement 20.4)` (3) | `__tests__/cancellation-contact-panel.test.tsx`, `domain/__tests__/escalation.test.ts` · 5 |
| 20 | payment reported | `records a payment report with the derived deadline and the supplied pending-send count` plus the rest of `CancellationPaymentReport` and `Payment Reported (Requirement 20.6)` | `__tests__/cancellation-payment-report.test.tsx` · 16, `domain/__tests__/escalation.test.ts` · 1 |
| 21 | reinstatement | `(b) offers Confirm Reinstatement to a manager on Reinstatement Pending` (3 lifecycle cases) and `matches Reinstatement Pending on that Case_Status alone` | `domain/__tests__/case-lifecycle.test.ts` · 3, `__tests__/derive.test.ts` · 2 |
| 22 | cancelled outcome | `reads an action as cleared only on Reinstated, Cancelled, or Resolved (reading 5)`, `(g) offers Mark Resolved on Reinstated, Cancelled, Invalid, and Duplicate`, `matches Resolved for Reinstated, Cancelled, and Resolved only` | `domain/__tests__/case-lifecycle.test.ts` · 2, `__tests__/derive.test.ts` · 1 |
| 23 | manual follow-up | `the seven escalation reasons` (4), `the raise plan` (11), `clearing every escalation reason` (10), `at most one notification per case and reason (Requirement 20.10)` (2) | `domain/__tests__/escalation.test.ts` · 65 |
| 24 | permissions | `__tests__/scheduler-auth.test.ts` (31), `__tests__/rls-role-enforcement.test.ts` (54), `__tests__/cancellation-manager-actions.test.tsx` (10), `clearSuppression: Manager_Role only (Req 21.9, 22.5, 22.6)` (9) | 4 files · 104 |
| 25 | audit history | `cancellation audit immutability` (25, integration run), `the audit timeline order` (5), `suppressChannel: repeated recording (append-only timeline)` (2) | `__tests__/audit-immutability.integration.test.ts`, `__tests__/drawer-controls.test.ts`, `domain/__tests__/suppression.test.ts` · 32 |

**Requirement 25.3 — no live provider is reached.** `src/features/cancellations/__tests__/provider-isolation.test.ts`, **13 of 13 passing**. It asserts the mock substitution on all three send paths (`deliverMessage`, `sendCommunication`, `runScheduler`), asserts that a send resolving to the real module instead of an injected mock is recorded as such, confines the email provider to `src/lib/email.ts` and the SMS provider to `src/lib/ringcentral-sms.ts` by scanning the other modules, and asserts that no route under `src/app/api/cancellations` imports either provider module.

**Requirement 25.4 — Property 1, CSV raw-row round trip (task 8.2).** `src/features/cancellations/import/__tests__/csv-round-trip.property.test.ts`, **23 of 23 passing**. `PBT-1: CSV raw-row round trip > preserves field count, field order, and every character of every field value` runs at `numRuns: 200`, above the 100-case minimum. The file also pins the Requirement 24.6 acceptable-difference set in both directions (21 cases) and round-trips the two real reports (`preserves the eficacia report`, `preserves the avisos report, embedded line breaks included`).

**Requirement 25.5 — Property 2, scheduler idempotency (task 14.3).** `src/features/cancellations/scheduler/__tests__/scheduler-idempotency.property.test.ts`, **2 of 2 passing**. `Property 2 — scheduler idempotency across repeated runs > produces the first run key set and one provider call per message, however many runs execute` runs at `NUM_RUNS = 300`. The companion case asserts the store double answers `23505` for a second Communication_Record on one Idempotency_Key, so the property is testing a real uniqueness constraint rather than a permissive stub.

**Requirement 25.6 — Property 3, forbidden token (task 12.3).** `src/features/cancellations/render/__tests__/forbidden-token.property.test.ts`, **40 of 40 passing**. `PBT-3: no forbidden token in any rendered output > renders no marker as a complete token in any subject or body` runs at `NUM_RUNS = 500`. The file additionally pins both sides of the boundary rule — embedded sequences must survive (`Hernandez`, `Aznanian`, `Nullarbor Freight`, `Nonesuch Realty`), bare markers must be substituted away or block — and reproduces the leaked-token counts observed in the real `avisos` report.

**Requirement 25.7 — 403 on the scheduler and on manager-only operations.** `src/features/cancellations/__tests__/scheduler-auth.test.ts`, **31 of 31 passing**: no `Authorization` header, a wrong token, a token that is a prefix of the secret, a token that is a suffix of the secret, the raw secret with no scheme, a lowercase scheme, a doubled space after the scheme, and the secret with one character appended are each refused with zero rows written; refusal happens before a database client exists; the exact `Bearer ${secret}` header and a `manager` session and a `super_admin` session are each authorized, with `super_admin` authorized everywhere `manager` is. The manager-only half of 25.7 is carried by `src/features/cancellations/__tests__/rls-role-enforcement.test.ts`, **54 of 54 passing**, including `manual send authorization returns 403 and writes nothing (Requirements 22.2, 22.6, 22.12)` (5) and `payment verification outcomes are Manager_Role only (Requirement 19.11)` (3).

**The 2 skipped files are not failures, and both pass in command 3.** `npm test` reports 38 skipped test cases in exactly two files, and command 3 runs those same two files to a full pass — 25 + 13 = 38, matching the skip count exactly:

| File | Cases skipped under `npm test` | Cases passing under `npm run test:integration` | Why it skips |
| --- | ---: | ---: | --- |
| `src/features/cancellations/__tests__/audit-immutability.integration.test.ts` | 25 | 25 | Needs the live project. Its header records that it "self-skips unless the Supabase Management API credentials are in the environment"; it reads `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`, and `vitest --run` does not read `.env.local`. The three protections it asserts (RLS with no update or delete policy, the `before update or delete` trigger, and `update`/`delete`/`truncate` revoked from `authenticated`, `anon`, and `service_role`) exist only in the database, so there is no unit-test form of them. |
| `src/features/time-attendance/server/__tests__/audit-immutability.integration.test.ts` | 13 | 13 | Same mechanism, same reason. Pre-existing, owned by the `time-attendance` work, and unchanged by this spec — it is the file the Phase 1 gate also recorded as skipped. |

Requirement 25.9 gates on **failing** tests ("zero failing test cases"), and both runs report zero of those: `npm test` 0 failed, `npm run test:integration` 0 failed. The two skips are also not left unverified — command 3 exists in this gate precisely so the 38 cases run against the live project inside the same verification run, which is a stronger result than the Phase 1 gate could record.

**Requirement 25.9 check:** four commands, four zero-error results, one tree state confirmed by an unchanged `HEAD` across the sequence. No record is voided, no re-run is owed, and the three recorded results Requirement 25.9 names (type check, test run, build) are all present with the integration run added on top. Deployment stays blocked on the manual manager action of Requirement 26.8 — this gate authorizes task 19.2 to commit, and nothing more.

## Task Dependency Graph

Parallel execution waves. Tasks in one wave are independent and write to different files; a wave starts only after every earlier wave completes. The four gate and commit tasks (6.2, 6.3, 19.1, 19.2) are barriers and are excluded from the waves.

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1"] },
    { "id": 1, "tasks": ["0.2"] },
    { "id": 2, "tasks": ["1.1"] },
    { "id": 3, "tasks": ["1.2", "2.1", "2.2", "2.3", "3.1"] },
    { "id": 4, "tasks": ["3.2", "4.1"] },
    { "id": 5, "tasks": ["3.3", "3.4", "4.2", "5.1"] },
    { "id": 6, "tasks": ["5.2"] },
    { "id": 7, "tasks": ["5.3"] },
    { "id": 8, "tasks": ["5.4", "5.5"] },
    { "id": 9, "tasks": ["6.1"] },
    { "id": 10, "tasks": ["7.1", "8.1", "9.1", "9.2", "10.1", "11.1"] },
    { "id": 11, "tasks": ["7.2", "7.4", "7.5", "7.8", "7.9", "8.2", "9.3", "10.2", "10.3", "11.2", "12.1"] },
    { "id": 12, "tasks": ["7.3", "9.4", "10.4", "12.2", "13.1"] },
    { "id": 13, "tasks": ["7.6", "7.10", "12.3", "12.4", "13.2"] },
    { "id": 14, "tasks": ["7.7", "9.5", "13.3"] },
    { "id": 15, "tasks": ["9.6", "14.2", "16.1", "16.2"] },
    { "id": 16, "tasks": ["14.1", "16.3", "16.4", "16.5"] },
    { "id": 17, "tasks": ["14.3", "14.4", "14.5", "15.1", "16.8", "16.9", "16.10", "16.11"] },
    { "id": 18, "tasks": ["15.2", "16.6"] },
    { "id": 19, "tasks": ["16.7", "16.12"] },
    { "id": 20, "tasks": ["17.1", "17.2", "18.1"] }
  ]
}
```

```mermaid
graph TD
  subgraph SETUP["Task 0 — branch setup"]
    T01["0.1 record git status"] --> T02["0.2 create feature/renewals-cancellations"]
  end

  subgraph P1["Phase 1 — Renewals UI revision"]
    T11["1.1 derive.ts nine helpers"]
    T12["1.2 derive tests"]
    T21["2.1 RenewalsSummaryBar"]
    T22["2.2 RenewalsTable"]
    T23["2.3 RenewalTimeline"]
    T31["3.1 RenewalContactComposer"]
    T32["3.2 RenewalDrawer"]
    T33["3.3 renewal-actions tests"]
    T34["3.4 renewal-evidence tests"]
    T41["4.1 RenewalManagerActions"]
    T42["4.2 manager-actions tests"]
    T51["5.1 RenewalsPage container"]
    T52["5.2 PolicyFollowUpPage shell"]
    T53["5.3 policy-follow-up route + registry"]
    T54["5.4 old renewals route redirect"]
    T55["5.5 permissions + structural tests"]
    T61["6.1 line budget"]
  end

  GATE1{{"6.2 PHASE 1 GATE — one run: npx tsc --noEmit + npm test + npm run build, all zero"}}
  C1["6.3 commit feat(renewals): simplify renewal workspace"]

  subgraph P2A["Phase 2 — migrations v1.10.0-v1.10.9"]
    M0["7.1 v1.10.0 core tables + role helpers"]
    M1["7.2 v1.10.1 templates"]
    M2["7.3 v1.10.2 communications + retry fn"]
    M3["7.4 v1.10.3 case activity"]
    M4["7.5 v1.10.4 settings"]
    M5["7.6 v1.10.5 import batch + recompute"]
    M6["7.7 v1.10.6 RLS"]
    M7["7.8 v1.10.7 user_notifications type"]
    M8["7.9 v1.10.8 evidence bucket"]
    M9["7.10 v1.10.9 seed templates + phrases"]
  end

  subgraph P2B["Phase 2 — pure modules"]
    CSV["8.1 csv.ts + serializeRawRow"]
    PROP1["8.2 Property 1 round trip"]
    CL["9.1 classify.ts"]
    MAP["9.2 mapping.ts"]
    FLD["9.3 fields.ts parsers"]
    PRV["9.4 preview.ts"]
    LDR["9.5 loader.ts"]
    ITEST["9.6 import tests"]
    CON["10.1 contacts.ts"]
    CTEST["10.2 contact tests"]
    SUP["10.3 suppression.ts"]
    STEST["10.4 suppression tests"]
    EMAIL["11.1 lib/email.ts"]
    ETEST["11.2 email tests"]
    REN["12.1 renderMessage"]
    GATEF["12.2 phrase + token gate"]
    PROP3["12.3 Property 3 forbidden token"]
    RTEST["12.4 render tests"]
    CS["13.1 deriveCommunicationStatus"]
    ESC["13.2 evaluateEscalations"]
    DTEST["13.3 status + escalation tests"]
  end

  subgraph P2C["Phase 2 — routes"]
    SND["14.2 reserve-then-send helper"]
    SCH["14.1 scheduler route"]
    PROP2["14.3 Property 2 idempotency"]
    SCHT["14.4 scheduler tests"]
    PISO["14.5 provider isolation"]
    SR["15.1 send route"]
    SRT["15.2 send route tests"]
  end

  subgraph P2D["Phase 2 — Cancellations UI"]
    API["16.1 cancellations api.ts"]
    DRV["16.2 cancellations derive.ts"]
    DRVT["16.3 derive tests"]
    SB["16.4 CancellationsSummaryBar"]
    TBL["16.5 CancellationsTable"]
    DRW["16.6 CancellationDrawer"]
    DRWT["16.7 drawer role tests"]
    CP["16.8 contact panel"]
    PR["16.9 payment report"]
    VP["16.10 verification panel"]
    MA["16.11 manager actions"]
    PAGE["16.12 CancellationsPage + tab wiring"]
  end

  subgraph P2E["Phase 2 — cross-cutting tests"]
    RLS["17.1 RLS role enforcement"]
    AUD["17.2 audit immutability (integration)"]
    AUTH["18.1 scheduler auth 403"]
  end

  GATE2{{"19.1 PHASE 2 GATE — one run: npx tsc --noEmit + npm test + npm run test:integration + npm run build"}}
  C2["19.2 commit feat(cancellations): add reminder and tracking workflow"]

  T02 --> T11
  T11 --> T12
  T02 --> T21
  T02 --> T22
  T02 --> T23
  T02 --> T31
  T31 --> T32
  T23 --> T32
  T32 --> T33
  T31 --> T34
  T41 --> T42
  T02 --> T41
  T11 --> T51
  T21 --> T51
  T22 --> T51
  T32 --> T51
  T41 --> T51
  T51 --> T52
  T52 --> T53
  T53 --> T54
  T53 --> T55
  T41 --> T55
  T12 --> T61
  T33 --> T61
  T34 --> T61
  T42 --> T61
  T54 --> T61
  T55 --> T61
  T61 --> GATE1
  GATE1 --> C1

  C1 --> M0
  C1 --> CSV
  C1 --> CL
  C1 --> MAP
  C1 --> CON
  C1 --> EMAIL
  C1 --> REN
  C1 --> CS

  M0 --> M1
  M0 --> M3
  M0 --> M4
  M0 --> M7
  M0 --> M8
  M1 --> M2
  M1 --> M9
  M0 --> M5
  M3 --> M5
  M2 --> M6
  M5 --> M6

  CSV --> PROP1
  CSV --> FLD
  CL --> FLD
  MAP --> PRV
  FLD --> PRV
  CON --> CTEST
  CON --> FLD
  SUP --> STEST
  CON --> SUP
  EMAIL --> ETEST
  REN --> GATEF
  GATEF --> PROP3
  GATEF --> RTEST
  M9 --> RTEST
  CS --> ESC
  CS --> DTEST
  ESC --> DTEST
  M5 --> LDR
  PRV --> LDR
  LDR --> ITEST
  PRV --> ITEST

  M2 --> SND
  EMAIL --> SND
  GATEF --> SND
  SND --> SCH
  CS --> SCH
  ESC --> SCH
  M4 --> SCH
  SUP --> SCH
  SCH --> PROP2
  SCH --> SCHT
  SCH --> PISO
  SND --> SR
  SR --> SRT

  M6 --> API
  CS --> DRV
  DRV --> DRVT
  DRV --> SB
  DRV --> TBL
  API --> SB
  API --> TBL
  API --> CP
  API --> PR
  API --> VP
  API --> MA
  LDR --> MA
  CON --> CP
  SUP --> CP
  ESC --> PR
  DRV --> DRW
  API --> DRW
  CP --> DRW
  PR --> DRW
  VP --> DRW
  SR --> DRW
  DRW --> DRWT
  DRW --> PAGE
  SB --> PAGE
  TBL --> PAGE
  MA --> PAGE

  M6 --> RLS
  M2 --> AUD
  SCH --> AUTH

  ITEST --> GATE2
  CTEST --> GATE2
  STEST --> GATE2
  ETEST --> GATE2
  PROP1 --> GATE2
  PROP2 --> GATE2
  PROP3 --> GATE2
  RTEST --> GATE2
  DTEST --> GATE2
  SCHT --> GATE2
  PISO --> GATE2
  SRT --> GATE2
  DRVT --> GATE2
  DRWT --> GATE2
  PAGE --> GATE2
  RLS --> GATE2
  AUD --> GATE2
  AUTH --> GATE2
  GATE2 --> C2
```
