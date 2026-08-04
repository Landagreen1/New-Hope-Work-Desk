# Requirements: cancellations-operational-hardening

Focused hardening pass on the existing Cancellations module. No rebuild, no redesign of Renewals or unrelated modules.

Test files: `eficacia_20260731.csv` (58 rows), `avisos_20260731_1535.csv` (51 rows).

---

## 1. Complementary-File Merging

### REQ-1.1: Source-Aware Field Ownership

The `cancellation_import_batch` RPC update branch must respect source ownership when merging eficacia and avisos data for the same case identity (normalized policy number + cancellation effective date).

**Eficacia controls:**
- `customer_name` (Cliente)
- `policy_number` (Poliza)
- `carrier` (Compania)
- `cancellation_effective_date` (FechaCancelacion)
- `amount_due` (MontoDebido)
- `producer_label` (Productor)
- `client_identifier` (ClienteID)
- `legacy_send_flag` (Enviar)
- `legacy_state` (Estado)
- `legacy_result` (Resultado)
- `legacy_notices_sent` (AvisosEnviados)
- `legacy_first_notice` (PrimerAviso)
- `legacy_last_notice` (UltimoAviso)

**Avisos controls:**
- Contact email addresses (Email column → `cancellation_contacts`)
- Contact phone numbers (Phone column → `cancellation_contacts`)
- `legacy_notice_label` (Aviso)
- `legacy_subject` (Asunto)
- `legacy_email_body` (MensajeEmail)
- `legacy_sms_body` (MensajeSMS)

### REQ-1.2: Conditional Avisos Override

Avisos may update `customer_name` or `carrier` only when the avisos value is populated (non-empty after trimming). Missing values from either source must preserve existing database values.

### REQ-1.3: No-Overwrite-With-Null Rule

A missing or blank value from either source file must never overwrite a populated value already stored in `cancellation_cases`. The RPC upsert must use `COALESCE(excluded.<col>, cancellation_cases.<col>)` for every field where the incoming value is null.

### REQ-1.4: Raw Row Preservation

Every imported raw row and its source file association must be preserved. The system must not retain only the latest raw row for a case. Each import run records its own `raw_row` and `raw_header` per case, allowing full audit trail across multiple imports.

### REQ-1.5: Regression Tests

Automated tests covering:
- Eficacia then avisos import order
- Avisos then eficacia import order
- Re-importing eficacia (no data loss)
- Re-importing avisos (no data loss)
- Blank values not erasing populated values
- Manager assignments remaining unchanged across imports
- Contact preferences and suppressions remaining unchanged across imports

---

## 2. Efficacy Operational Outcome Mapping

### REQ-2.1: Status Derivation from Enviar/Estado/Resultado

Use the eficacia fields `Enviar`, `Estado`, and `Resultado` to determine the imported case status:

| Enviar | Estado | Resultado | Imported Status | Reminder Eligible |
|--------|--------|-----------|----------------|-------------------|
| `true` (Sí/Si/TRUE/1) | Pendiente / En curso | — | `Imported` (active, open) | Yes |
| `false` (No/FALSE/0) | Pagada | Recuperada | `Reinstated` | No |
| `false` | Cancelada | Perdida | `Cancelled` | No |
| `false` | unclear/other | unclear/other | `Import Review Required` | No |
| conflicting combination | — | — | `Import Review Required` | No |

### REQ-2.2: New Case Status Value

Add `Import Review Required` to the `CaseStatus` type and database constraint. Cases with this status are excluded from automatic reminder scheduling (they are not in `OPEN_CASE_STATUSES`).

### REQ-2.3: Preview Status Display

The import preview must show the proposed status for each row before confirmation. For the supplied eficacia file, the preview must display:
- 54 active pending cases
- 3 paid/recovered cases
- 1 cancelled/lost case

### REQ-2.4: Reminder Eligibility Gate

Only cases with status `Imported` or `Open` may enter automatic reminder scheduling. Cases mapped to `Reinstated`, `Cancelled`, or `Import Review Required` must never receive automatic communications.

---

## 3. Automatic Sending Safety

### REQ-3.1: Default Disabled

New installations must default `automatic_sending_enabled` to `false` in `cancellation_settings`. An existing production setting must never be changed by a migration or deployment.

### REQ-3.2: Readiness Panel

Add a visible readiness panel accessible to managers showing:
- Database readiness (migrations applied, settings row exists)
- SMS configuration status (RingCentral environment variables present)
- Email configuration status (Resend environment variables present)
- Template readiness (all four touchpoint templates have at least one version)
- Scheduler configuration (CRON_SECRET configured, route registered)
- Last scheduler run timestamp
- Last scheduler result summary (sent/skipped/failed counts)
- Automatic sending ON/OFF toggle with current state
- Failed communication count (current)
- Missing-contact count (current open cases with no eligible contact)

### REQ-3.3: Explicit Activation

A manager must explicitly activate automatic sending after reviewing the readiness panel. The activation requires all readiness checks to pass.

### REQ-3.4: Test-Send Mode

Add a test-send mode that:
- Sends only to a manager-provided test phone number or email address
- Must never replace a customer contact in the database
- Must never create a `cancellation_communications` row with `delivery_result = 'Sent'` against a customer contact
- Records the test send in a separate audit path (e.g., `cancellation_test_sends`)
- Allows managers to verify template rendering and provider connectivity without customer impact

---

## 4. Navigation and Discoverability

### REQ-4.1: URL Tab Persistence

Support URL-driven tab selection:
- `/tools/policy-follow-up?tab=renewals` → opens Renewals tab
- `/tools/policy-follow-up?tab=cancellations` → opens Cancellations tab

The selected tab must persist through browser refresh and back/forward navigation via `useSearchParams`.

### REQ-4.2: Direct Cancellations Launcher

Add a direct "Cancellations" entry in the Operations Tools navigation that links to `/tools/policy-follow-up?tab=cancellations`.

### REQ-4.3: Import Button Placement

For managers (`isBroadManagerRole`), place a visible "Import Cancellations" button in the Cancellations tab header area, outside the collapsed manager actions panel.

### REQ-4.4: Manager Settings Area

Move advanced controls into a secondary "Manager Settings" section within CancellationManagerActions:
- Message templates
- Assignment mapping corrections
- Automatic-sending configuration
- Data corrections

The import wizard remains directly accessible from REQ-4.3.

---

## 5. Guided Two-File Import

### REQ-5.1: Workflow Steps

The manager import workflow must be:
1. Upload eficacia cancellation cases file
2. Upload avisos contact information file
3. Review reconciliation summary
4. Resolve flagged issues
5. Complete import (confirm)

Both files may be uploaded independently (eficacia-only or avisos-only remain valid), but when both are provided, the guided flow applies.

### REQ-5.2: Reconciliation Summary

For the supplied test files, the reconciliation screen must display:
- 58 eficacia cases
- 51 avisos rows
- 51 matching cases (same identity in both files)
- 7 eficacia-only cases (no avisos contact data)
- 0 avisos-only cases
- 54 active cases (eligible for reminders)
- 3 paid/recovered cases
- 1 cancelled/lost case
- 18 missing producer values
- 2 deleted producer labels
- Multiple email/phone segments split into separate contacts
- 6 customers with multiple policies

### REQ-5.3: Avisos Non-Duplication

The avisos import must update existing cases (matched by identity) and add/update contacts. It must never create duplicate `cancellation_cases` rows for a case identity that already exists.

### REQ-5.4: Reconciliation Issue Panel

Add a reconciliation screen showing actionable categories:
- Unassigned cases (no producer mapping match)
- Missing contacts (eficacia-only cases with no avisos data)
- Invalid contacts (phone/email validation failures)
- Status conflicts (ambiguous Enviar/Estado/Resultado)
- Deleted producer labels (ending with "(Deleted)")
- Multiple-policy groups (same customer, different policies)
- Cases excluded from reminders (non-open status)
- Cases ready for reminders (open + has eligible contact)

---

## 6. Agent Follow-Up Recording

### REQ-6.1: Record Follow-Up Action

Add a prominent "Record Follow-up" action button in the cancellation drawer, visible to all roles with Policy Follow-up access.

### REQ-6.2: Follow-Up Form Fields

Collect in one form:
- Contact method (Phone / Email / SMS / WhatsApp / In-person)
- Direction (Inbound / Outbound)
- Contact used (select from case contacts or enter manual)
- Outcome (see REQ-6.3)
- Notes (required, 1–4000 characters)
- Customer response summary
- Payment reported (boolean)
- Evidence (file upload, max 10 files, 100 MB each)
- Next follow-up date (optional date picker)
- Next required action (select from the nine actions)

### REQ-6.3: Outcome Values

- No answer
- Left voicemail
- Message sent
- Email sent
- Spoke with customer
- Customer requested assistance
- Customer reports payment
- Wrong contact information
- Customer will not pay
- Customer accepts cancellation
- Other

### REQ-6.4: Consolidated Audit Event

Store one `cancellation_events` entry per follow-up recording containing the full form payload. Do not create multiple events for a single follow-up action.

### REQ-6.5: Preserve Existing Panels

The existing specialized payment report panel (`CancellationPaymentReport`) and verification panel (`CancellationVerificationPanel`) remain intact. The follow-up form is an additional, more general action that complements them.

---

## 7. Ownership Clarity

### REQ-7.1: Agent Default View

Agent default view configuration:
- Title: "My Cancellations"
- Filter: assigned to the signed-in profile
- Sub-filter: Needs Action
- Sort: follow-up deadline ascending, then cancellation effective date ascending

### REQ-7.2: Manager Default View

Manager default view configuration:
- Title: "Team Cancellations"
- Shows all cases
- Quick filters for: Unassigned, Missing producer mapping, By employee
- Unassigned cases surfaced with visual indicator

### REQ-7.3: Ownership Process

Implement either:
- A manager-only assignment workflow (assign unassigned cases to employees), OR
- A controlled "Claim Cancellation" action for unassigned cases (agent self-assigns)

Both require:
- Manager (`isBroadManagerRole`) can assign any unassigned case to any active employee
- An unassigned case must have a clear path to ownership
- Assignment creates a `cancellation_events` entry with `event_type = 'assignment'`

---

## 8. Deployment Readiness Verification

### REQ-8.1: Pre-Flight Checks

Document and verify before any automatic sending:
- All v1.10.x migrations applied to the target Supabase project
- Vercel `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` configured
- RingCentral SMS environment variables configured (`RINGCENTRAL_*`)
- Resend email environment variables configured (`RESEND_*`)
- `CRON_SECRET` environment variable configured
- Scheduler route `/api/cancellations/scheduler` is registered and receiving cron invocations
- Last-run information is recorded in `cancellation_scheduler_runs` and visible in the readiness panel

### REQ-8.2: Safety During Testing

During test-file validation:
- Automatic sending must remain OFF
- No messages may be sent to contacts from the supplied test files during automated tests
- Test sends use only the manager-provided test recipient (REQ-3.4)

### REQ-8.3: Deployment Report

Provide a deployment readiness report documenting:
- Migration application status
- Environment variable presence (not values)
- Scheduler invocation evidence
- Automatic sending state
- Test-send results

---

## Validation Criteria

Run and pass:
1. `npx tsc --noEmit` — zero type errors
2. `npm test` — existing cancellation tests pass
3. New complementary-import regression tests (REQ-1.5)
4. Status-mapping tests (REQ-2.1 rules)
5. Integration tests (import with both files, reconciliation counts)
6. `npm run build` — production build succeeds

Deliver:
1. Files changed list
2. New forward-only migration SQL
3. Before-and-after import results using both supplied files
4. Screenshots of the manager import flow
5. Screenshots of the agent follow-up flow
6. Deployment readiness report
7. Exact test results
