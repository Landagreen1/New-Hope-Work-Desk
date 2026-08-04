# Design: cancellations-operational-hardening

Branch: `fix/cancellations-operational-hardening`

Hardening pass — no module rebuild. Existing tables, drawer, communication services, and tests remain in place.

---

## 1. Complementary-File Merging (REQ-1.x)

### 1.1 Problem

The current `cancellation_import_batch` RPC upserts on the identity constraint `(policy_number_normalized, cancellation_effective_date)`. When a case already exists and an update comes from the other source file, the upsert's `ON CONFLICT ... DO UPDATE SET` clause overwrites every column with the incoming value — including null columns the other source never carried. This means an avisos import can blank eficacia-owned fields and vice versa.

### 1.2 Solution: Source-Aware COALESCE in the RPC

**New forward-only migration:** `v1.10.10-cancellation-source-aware-merge.sql`

Modify the `ON CONFLICT` clause in `cancellation_import_batch` to use `COALESCE(EXCLUDED.<col>, cancellation_cases.<col>)` for all non-identity columns. This ensures a null incoming value never overwrites a populated stored value.

Additionally, introduce a `p_column_set` parameter gate inside the update branch:

```sql
-- Eficacia-owned fields: only written when p_column_set = 'eficacia'
customer_name = CASE WHEN p_column_set = 'eficacia'
  THEN COALESCE(EXCLUDED.customer_name, cancellation_cases.customer_name)
  ELSE COALESCE(NULLIF(EXCLUDED.customer_name, ''), cancellation_cases.customer_name)
END,

-- Avisos-owned fields: only written when p_column_set = 'avisos'
legacy_notice_label = CASE WHEN p_column_set = 'avisos'
  THEN COALESCE(EXCLUDED.legacy_notice_label, cancellation_cases.legacy_notice_label)
  ELSE cancellation_cases.legacy_notice_label
END,
```

Key rules:
- Eficacia-owned columns: written freely by eficacia, preserved by avisos (avisos may update `customer_name`/`carrier` only when non-empty via `NULLIF`).
- Avisos-owned columns: written freely by avisos, preserved by eficacia.
- `assigned_to`: always `COALESCE(EXCLUDED.assigned_to, cancellation_cases.assigned_to)` — never cleared by import.
- Contact preferences, suppressions: not touched by the import at all (separate tables).

### 1.3 Raw Row Preservation

**Current:** `cancellation_cases.raw_row` and `raw_header` store a single row per case.

**Change:** Add `cancellation_import_case_rows` join table:

```sql
CREATE TABLE public.cancellation_import_case_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES cancellation_cases(id),
  import_run_id uuid NOT NULL REFERENCES cancellation_import_runs(id),
  source_row_number integer NOT NULL,
  raw_row jsonb NOT NULL CHECK (jsonb_typeof(raw_row) = 'array'),
  raw_header text[] NOT NULL,
  column_set text NOT NULL CHECK (column_set IN ('eficacia', 'avisos')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_import_case_rows_case ON cancellation_import_case_rows(case_id);
CREATE INDEX idx_import_case_rows_run ON cancellation_import_case_rows(import_run_id);
```

The RPC inserts into this table for every row (create or update), preserving the full audit trail. The existing `raw_row`/`raw_header` on `cancellation_cases` remains as the most-recent snapshot for backward compatibility with the drawer's "imported data" view.

### 1.4 TypeScript Changes

- `src/features/cancellations/import/loader.ts`: Pass `columnSet` through to the RPC call as it already does.
- `src/features/cancellations/import/preview.ts`: No change (preview is pure).
- `src/features/cancellations/api.ts`: Add `listCaseImportRows(caseId)` for the drawer audit history.

### 1.5 Test Fixtures

Create `src/features/cancellations/__tests__/fixtures/`:
- `eficacia_20260731.csv` — 58 rows with the specified outcome distribution
- `avisos_20260731_1535.csv` — 51 rows with contacts

### 1.6 Regression Test Module

`src/features/cancellations/__tests__/complementary-merge.test.ts`:
- Uses the loader's double-capable interface (injectable Supabase client mock)
- Tests all seven scenarios from REQ-1.5

---

## 2. Efficacy Operational Outcome Mapping (REQ-2.x)

### 2.1 Status Derivation Module

New file: `src/features/cancellations/import/status-mapping.ts`

Pure function, no I/O:

```typescript
export type ImportedCaseStatus = 'Imported' | 'Reinstated' | 'Cancelled' | 'Import Review Required';

export interface StatusMappingInput {
  enviar: string | null;    // legacy_send_flag raw value
  estado: string | null;    // legacy_state raw value
  resultado: string | null; // legacy_result raw value
}

export function deriveImportedStatus(input: StatusMappingInput): ImportedCaseStatus;
```

Parsing rules:
- `enviar` truthy: `'Sí'`, `'Si'`, `'SI'`, `'TRUE'`, `'true'`, `'1'`, `'Yes'`, `'yes'`
- `enviar` falsy: `'No'`, `'NO'`, `'FALSE'`, `'false'`, `'0'`, empty, null
- `estado` pending: `'Pendiente'`, `'En curso'` (case-insensitive, trimmed)
- `estado` paid: `'Pagada'` (case-insensitive, trimmed)
- `estado` cancelled: `'Cancelada'` (case-insensitive, trimmed)
- `resultado` recovered: `'Recuperada'` (case-insensitive, trimmed)
- `resultado` lost: `'Perdida'` (case-insensitive, trimmed)

### 2.2 Integration with Import Pipeline

In `src/features/cancellations/import/fields.ts`, after parsing legacy columns, call `deriveImportedStatus` and include the result in `CancellationCaseFields.case_status`.

Currently the pipeline always sets `case_status = 'Imported'` for new cases. Change to:
- For eficacia column set: use `deriveImportedStatus(enviar, estado, resultado)`
- For avisos column set: default to `'Imported'` (avisos has no operational status fields)
- For updates: only update `case_status` if the incoming status is more "resolved" than the stored one (never downgrade from Open to Imported, never override a manager's status change)

### 2.3 New CaseStatus Value

**Migration** adds `'Import Review Required'` to the `cancellation_cases` check constraint on `case_status`. Update `CASE_STATUSES` array and `CaseStatus` type in `domain/communication-status.ts`.

`Import Review Required` is NOT in `OPEN_CASE_STATUSES` and NOT in `ACTIVE_CASE_STATUSES`, so it is excluded from scheduler evaluation and from the agent's default view.

### 2.4 Preview Enhancement

In `preview.ts`'s `ImportPreview` result, add:

```typescript
readonly statusCounts: Record<ImportedCaseStatus, number>;
```

The wizard renders these counts in the preview step before confirmation.

---

## 3. Automatic Sending Safety (REQ-3.x)

### 3.1 Default Disabled

**Migration:** `ALTER TABLE cancellation_settings ALTER COLUMN automatic_sending_enabled SET DEFAULT false;`

The seed in `v1.10.4` already inserts `false`. This ALTER ensures any future `INSERT ... DEFAULT` respects it. No existing row is modified.

### 3.2 Readiness Panel Component

New file: `src/features/cancellations/CancellationReadinessPanel.tsx`

Reads:
- `cancellation_settings` → `automatic_sending_enabled`, `updated_at`
- `cancellation_templates` + versions → checks all four touchpoints have ≥1 version
- `cancellation_scheduler_runs` (new table, see below) → last run timestamp and summary
- Server-side readiness API (REQ-3.2 checks that require env var presence)

New API route: `POST /api/cancellations/readiness`
- Checks env vars (presence only, never returns values): `CRON_SECRET`, `RINGCENTRAL_*`, `RESEND_*`, `SUPABASE_SECRET_KEY`
- Returns `{ database: boolean, sms: boolean, email: boolean, cron: boolean }`

### 3.3 Scheduler Run Logging

**Migration:** Add `cancellation_scheduler_runs` table:

```sql
CREATE TABLE public.cancellation_scheduler_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date date NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  automatic_sending_enabled boolean NOT NULL,
  cases_evaluated integer NOT NULL DEFAULT 0,
  sent integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  summary jsonb,
  actor_kind text CHECK (actor_kind IN ('cron', 'session')),
  actor_profile_id uuid
);
```

`scheduler/run.ts` inserts a row at the start and updates it at completion. The readiness panel reads the most recent row.

### 3.4 Test-Send Mode

New file: `src/features/cancellations/scheduler/test-send.ts`

- Accepts a `testRecipient: { phone?: string; email?: string }`
- Renders the template for a selected case + touchpoint using the real renderer
- Sends to the test recipient only
- Records in `cancellation_test_sends` table (new migration)
- Never writes to `cancellation_communications` or `cancellation_communication_cases`

UI: Button in the readiness panel "Send Test Message" opening a small form.

---

## 4. Navigation and Discoverability (REQ-4.x)

### 4.1 URL Tab Persistence

In `src/features/renewals/PolicyFollowUpPage.tsx`:

Replace `useState<PolicyFollowUpTabId>(INITIAL_TAB)` with a `useSearchParams`-driven approach:

```typescript
const searchParams = useSearchParams();
const router = useRouter();
const tabParam = searchParams.get('tab');
const activeTab: PolicyFollowUpTabId =
  tabParam === 'cancellations' ? 'cancellations' : 'renewals';

const selectTab = useCallback((next: PolicyFollowUpTabId) => {
  // retain UI state refs as before
  setRestoredRenewalsUi(renewalsUi.current);
  setRestoredCancellationsUi(cancellationsUi.current);
  const params = new URLSearchParams(searchParams.toString());
  params.set('tab', next);
  router.replace(`?${params.toString()}`, { scroll: false });
}, [searchParams, router]);
```

The page route at `src/app/tools/policy-follow-up/page.tsx` already uses `force-dynamic`, so `useSearchParams` works without a Suspense boundary issue.

### 4.2 Direct Cancellations Launcher

In `src/platform/module-registry.ts` (or wherever Operations Tools navigation is defined), add:

```typescript
{ id: 'cancellations', label: 'Cancellations', href: '/tools/policy-follow-up?tab=cancellations', ... }
```

### 4.3 Import Button in Header

In `CancellationsPage.tsx`, add a "Import Cancellations" button next to the summary bar when `isBroadManagerRole(profile.role)`. Clicking it opens the import wizard directly (same behavior as the existing manager action, but elevated to header level).

### 4.4 Manager Settings Reorganization

In `CancellationManagerActions.tsx`, restructure the collapsed panel sections:
- **Top level (always visible to managers):** Import Cancellations button (REQ-4.3)
- **Manager Settings section (collapsed):** Templates, Assignment Mapping, Automatic Sending, Data Corrections

No logic change — only UI grouping.

---

## 5. Guided Two-File Import (REQ-5.x)

### 5.1 Import Wizard State Machine

Extend the existing wizard in `CancellationManagerActions.tsx` from 5 stages to 7:

```
upload_eficacia → upload_avisos → reconciliation → resolve_issues → mapping_review → preview → complete
```

New state: the wizard tracks two parsed files and their previews:

```typescript
interface TwoFileImportState {
  eficacia: { parsed: ParsedCsv; classified: ClassifiedImportFile; preview: ImportPreview } | null;
  avisos: { parsed: ParsedCsv; classified: ClassifiedImportFile; preview: ImportPreview } | null;
  reconciliation: ReconciliationSummary | null;
}
```

### 5.2 Reconciliation Module

New file: `src/features/cancellations/import/reconcile.ts`

Pure function:

```typescript
export interface ReconciliationSummary {
  eficaciaCaseCount: number;
  avisosRowCount: number;
  matchingCases: number;          // identity present in both
  eficaciaOnlyCases: number;      // identity in eficacia only
  avisosOnlyCases: number;        // identity in avisos only
  activeCases: number;            // status maps to Imported
  paidRecoveredCases: number;     // status maps to Reinstated
  cancelledLostCases: number;     // status maps to Cancelled
  missingProducerCount: number;
  deletedProducerCount: number;
  multiPolicyCustomers: number;   // same customer_match_key, different policies
  issues: ReconciliationIssue[];
}

export function reconcileImports(
  eficaciaPreview: ImportPreview | null,
  avisosPreview: ImportPreview | null,
  existingCases?: Map<string, StoredCaseIdentityRow>,
): ReconciliationSummary;
```

### 5.3 Reconciliation UI

New file: `src/features/cancellations/CancellationReconciliationPanel.tsx`

Renders:
- Summary counts in a card grid
- Issue categories as expandable sections with row-level detail
- Action buttons: "Resolve All" (auto-assign defaults), "Skip" (proceed with issues noted)
- Each issue category maps to REQ-5.4's list

### 5.4 Two-File Load Sequence

When both files are confirmed:
1. Load eficacia first (creates cases, sets statuses, resolves producers)
2. Load avisos second (updates contacts, updates avisos-owned legacy fields, never creates duplicate cases)
3. The source-aware merge of §1.2 ensures no field clobbering

---

## 6. Agent Follow-Up Recording (REQ-6.x)

### 6.1 Database

**Migration** adds to `cancellation_events.event_type` constraint: `'follow_up'`

The `cancellation_events.detail` jsonb column carries the full follow-up payload:

```jsonb
{
  "type": "follow_up",
  "contact_method": "Phone",
  "direction": "Outbound",
  "contact_used": "+13055551234",
  "outcome": "Spoke with customer",
  "notes": "Customer will make payment Friday...",
  "customer_response": "Agreed to pay",
  "payment_reported": false,
  "evidence_files": ["uuid1", "uuid2"],
  "next_follow_up_date": "2026-08-05",
  "next_required_action": "Record Customer Response"
}
```

### 6.2 API

In `src/features/cancellations/api.ts`, add:

```typescript
export async function recordFollowUp(
  caseId: string,
  payload: FollowUpPayload,
  actor: CancellationActor,
): Promise<void>;
```

This function:
1. Inserts one `cancellation_events` row
2. Updates `cancellation_cases.next_required_action` if provided
3. Updates `cancellation_cases.follow_up_deadline` if `next_follow_up_date` provided
4. If `payment_reported === true`, sets `case_status = 'Payment Reported'`

### 6.3 UI Component

New file: `src/features/cancellations/CancellationFollowUpForm.tsx`

- Rendered inside `CancellationDrawer` as a slide-out section (same pattern as CancellationContactPanel)
- Triggered by a "Record Follow-up" button positioned prominently below the primary action
- Form validation: notes required (1–4000 chars), outcome required, contact method required
- On success: refreshes drawer reads, shows success notice, closes form

### 6.4 Outcome Enum

In `domain/communication-status.ts` or a new `domain/follow-up.ts`:

```typescript
export const FOLLOW_UP_OUTCOMES = [
  'No answer',
  'Left voicemail',
  'Message sent',
  'Email sent',
  'Spoke with customer',
  'Customer requested assistance',
  'Customer reports payment',
  'Wrong contact information',
  'Customer will not pay',
  'Customer accepts cancellation',
  'Other',
] as const;
export type FollowUpOutcome = (typeof FOLLOW_UP_OUTCOMES)[number];
```

---

## 7. Ownership Clarity (REQ-7.x)

### 7.1 Agent View Filter

In `src/features/cancellations/derive.ts`, add a new saved filter:

```typescript
{ id: 'my-cases', label: 'My Cases' }
```

Matching rule: `case.assigned_to === viewer.profileId && isActiveStatus(case.case_status)`

For agents (`!isBroadManagerRole`), the default filter resolves to `'my-cases'` instead of `'needs-action'`.

### 7.2 Manager View Filters

Add manager-only filters:

```typescript
{ id: 'unassigned', label: 'Unassigned' }         // assigned_to is null
{ id: 'missing-producer', label: 'Missing Producer' }  // producer_label present but no mapping
{ id: 'by-employee', label: 'By Employee' }        // grouped view, manager only
```

These appear in the filter bar only when `isBroadManagerRole(viewer.role)`.

### 7.3 Claim / Assign Action

**Manager assignment:** In `CancellationManagerActions.tsx`, the existing `assignCancellationCase` API is already built. Surface it more prominently for unassigned cases — add a "Quick Assign" dropdown in the table row actions for unassigned rows (visible only to managers).

**Agent claim:** Add `claimCancellationCase(caseId, actor)` in `api.ts`:
- Only works when `case.assigned_to === null`
- Sets `assigned_to = actor.id`, `assignment_source = 'claim'`
- Inserts assignment event
- Visible in drawer as "Claim This Case" button when unassigned and viewer is not a manager

---

## 8. Deployment Readiness (REQ-8.x)

### 8.1 Readiness API Route

`POST /api/cancellations/readiness` (manager-only, session-gated):

```typescript
export interface ReadinessReport {
  database: { migrated: boolean; settingsExists: boolean };
  sms: { configured: boolean };
  email: { configured: boolean };
  templates: { complete: boolean; missing: string[] };
  scheduler: { cronSecretSet: boolean; lastRun: string | null; lastResult: SchedulerRunSummary | null };
  sending: { enabled: boolean; failedCount: number; missingContactCount: number };
}
```

Checks `process.env` for presence (never returns values). Queries `cancellation_scheduler_runs` for last run. Queries `cancellation_cases` for failed/missing-contact counts.

### 8.2 No Test-File Customer Contact

The test fixtures in `__tests__/fixtures/` contain synthetic data only. Integration tests that exercise the scheduler use provider mocks (already the pattern in `scheduler/run.ts`'s injectable `SendProviders`). No real provider call is made during `npm test` or `npm run test:integration`.

### 8.3 Deployment Checklist

Rendered in the readiness panel as a progress list. Each item shows ✓ or ✗ based on the readiness API response. Manager cannot toggle `automatic_sending_enabled` to `true` while any check fails.

---

## Migration Summary

| File | Purpose |
|------|---------|
| `v1.10.10-cancellation-source-aware-merge.sql` | Source-aware COALESCE in import batch, `cancellation_import_case_rows` table, `Import Review Required` status value, `follow_up` event type, `cancellation_scheduler_runs` table, `cancellation_test_sends` table, default `false` for `automatic_sending_enabled` |

Single forward-only migration. Does not modify historical migrations. Does not alter any pre-v1.10.x table or function.

---

## File Change Summary

### New Files
| Path | Purpose |
|------|---------|
| `src/features/cancellations/import/status-mapping.ts` | Pure status derivation from Enviar/Estado/Resultado |
| `src/features/cancellations/import/reconcile.ts` | Pure reconciliation of two-file import |
| `src/features/cancellations/CancellationReadinessPanel.tsx` | Readiness dashboard for managers |
| `src/features/cancellations/CancellationReconciliationPanel.tsx` | Reconciliation UI for guided import |
| `src/features/cancellations/CancellationFollowUpForm.tsx` | Agent follow-up recording form |
| `src/features/cancellations/domain/follow-up.ts` | Follow-up outcome types and constants |
| `src/features/cancellations/scheduler/test-send.ts` | Test-send logic |
| `src/app/api/cancellations/readiness/route.ts` | Readiness check endpoint |
| `src/features/cancellations/__tests__/fixtures/eficacia_20260731.csv` | Test fixture |
| `src/features/cancellations/__tests__/fixtures/avisos_20260731_1535.csv` | Test fixture |
| `src/features/cancellations/__tests__/complementary-merge.test.ts` | Merge regression tests |
| `src/features/cancellations/__tests__/status-mapping.test.ts` | Status mapping tests |
| `src/features/cancellations/__tests__/reconciliation.test.ts` | Reconciliation tests |
| `supabase/migrations/v1.10.10-cancellation-source-aware-merge.sql` | Forward-only migration |

### Modified Files
| Path | Change |
|------|--------|
| `src/features/cancellations/import/fields.ts` | Call `deriveImportedStatus` for eficacia rows |
| `src/features/cancellations/import/loader.ts` | Pass status to RPC, insert import_case_rows |
| `src/features/cancellations/import/preview.ts` | Add `statusCounts` to `ImportPreview` |
| `src/features/cancellations/domain/communication-status.ts` | Add `'Import Review Required'` to types |
| `src/features/cancellations/derive.ts` | Add `my-cases`, `unassigned`, `missing-producer` filters |
| `src/features/cancellations/api.ts` | Add `recordFollowUp`, `claimCancellationCase`, `listCaseImportRows` |
| `src/features/cancellations/CancellationsPage.tsx` | Agent/manager default view, import button |
| `src/features/cancellations/CancellationManagerActions.tsx` | Restructure to guided import + settings |
| `src/features/cancellations/CancellationDrawer.tsx` | Add follow-up button, claim button |
| `src/features/renewals/PolicyFollowUpPage.tsx` | URL-driven tab selection |
| `src/app/tools/policy-follow-up/page.tsx` | Wrap with Suspense for useSearchParams |
| `src/features/cancellations/scheduler/run.ts` | Log to `cancellation_scheduler_runs` |
