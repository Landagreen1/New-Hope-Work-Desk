# Design: policy-follow-up-assignment-workflow

Branch recommendation: `feat/policy-follow-up-assignment-workflow`

This design extends the existing Policy Follow-up architecture. It deliberately avoids a new replacement module.

---

## 1. Repository baseline to preserve

At the time this spec was written, the repository already contains:
- `src/features/renewals/PolicyFollowUpPage.tsx`
- `src/features/renewals/RenewalsPage.tsx`
- `src/features/renewals/RenewalsSummaryBar.tsx`
- `src/features/renewals/RenewalsTable.tsx`
- `src/features/renewals/RenewalDrawer.tsx`
- `src/features/renewals/RenewalManagerActions.tsx`
- `src/features/renewals/derive.ts`
- `src/features/renewals/api.ts`
- `src/features/cancellations/CancellationsPage.tsx`
- `src/features/cancellations/CancellationsSummaryBar.tsx`
- `src/features/cancellations/CancellationsTable.tsx`
- `src/features/cancellations/CancellationDrawer.tsx`
- `src/features/cancellations/CancellationManagerActions.tsx`
- `src/features/cancellations/derive.ts`
- `src/features/cancellations/domain/communication-status.ts`

Current Renewals already derives summary filters and `recommendedNextAction`. Current Cancellations already derives list cells, saved filters, communication status, and a role-aware `deriveNextRequiredAction` used by the drawer/list.

Do not replace these derivation engines. Extend/adapt them.

A known renewal baseline issue is that `RenewalsPage.tsx` currently supplies an empty contact index at list level, so No Contact / Last Contact / Next Action values cannot use real contact history. This spec fixes that explicitly.

---

## 2. High-level architecture

```text
Renewal collector CSV       Cancellation collector CSV
          |                           |
          v                           v
   Renewal importer            Cancellation importer
          |                           |
          +------------+--------------+
                       |
                       v
              Source domain records
          renewal_records / cancellation_cases
                       |
             +---------+----------+
             |                    |
             v                    v
 Shared policy ownership     Domain history/events
             |                    |
             +---------+----------+
                       |
                       v
             Operational projection
               (current work only)
                       |
          +------------+-------------+
          |                          |
          v                          v
       My Work                 Manager Overview
          |                          |
          +------------+-------------+
                       |
                       v
             Existing domain drawer
```

The operational projection is not a second lifecycle database. It is a read model built from the authoritative domain records/history.

---

## 3. Normalization design

### 3.1 Shared normalization folder

Recommended new folder:

`src/features/policy-follow-up/`

Suggested files:
- `types.ts`
- `normalization.ts`
- `ownership.ts`
- `workload.ts`
- `work-projection.ts`
- `api.ts`
- `MyPolicyWorkPage.tsx`
- `PolicyFollowUpManagerOverview.tsx`
- `PolicyFollowUpImports.tsx`
- `PolicyWorkTable.tsx`

If repository conventions favor `src/features/renewals/*` as the shared shell location, keep the shell there and add only genuinely shared domain modules under `policy-follow-up`.

### 3.2 Normalized imported status

Use stable machine values, for example:

```ts
export type PolicySourceState =
  | 'renewal'
  | 'carrier_nonrenewal'
  | 'pending_cancellation'
  | 'payment_signal'
  | 'cancelled_signal'
  | 'review_required';
```

Do not force existing RenewalStatus/CaseStatus to become this union. This is a source-normalization layer, not a replacement lifecycle.

### 3.3 Raw + normalized fields

For collector-origin records, persist enough metadata to answer:
- What did carrier/collector actually say?
- How did Work Desk interpret it?
- Which file/row did it come from?
- Was it a reliable customer match?

Recommended additive source metadata fields for Renewals if not already implemented:
- `source_system text`
- `source_record_type text`
- `source_status_raw text`
- `source_state_normalized text`
- `source_match_status text`
- `source_match_method text`
- `source_file_name text`
- `source_row_number integer`
- `source_warning text`
- `source_payload jsonb`

Cancellations should use corresponding existing/additive fields rather than reusing legacy efficacy/avisos semantics for new collector imports.

---

## 4. Shared policy ownership

### 4.1 New table

Recommended migration:

`policy_followup_policy_owners`

```sql
create table public.policy_followup_policy_owners (
  id uuid primary key default gen_random_uuid(),
  carrier_key text not null,
  policy_number_normalized text not null,
  assigned_to uuid references public.profiles(id),
  assignment_source text not null check (assignment_source in (
    'migration', 'existing_owner', 'producer_mapping', 'weighted_auto', 'manager'
  )),
  assignment_locked boolean not null default false,
  assigned_by uuid references public.profiles(id),
  assigned_at timestamptz not null default now(),
  last_auto_assigned_at timestamptz,
  manager_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (carrier_key, policy_number_normalized)
);
```

Use the repository's existing profile FK convention and updated-at trigger pattern.

### 4.2 Carrier normalization

Create one `normalizeCarrierKey` definition shared by import and ownership. Examples may remove whitespace/punctuation and map known display aliases, but do not merge two carriers based only on fuzzy similarity.

When carrier is missing/unrecognized, do not create a cross-domain ownership link based on policy alone. Mark review-required.

### 4.3 Ownership synchronization

Add server-side helpers/RPCs:
- `policy_followup_resolve_owner(...)`
- `policy_followup_assign_policy(...)`
- `policy_followup_unlock_policy_owner(...)`

`resolve_owner` implements Requirements 3.3 precedence.

When an owner is resolved, mirror it to the active domain record for compatibility:
- `renewal_records.assigned_to`
- `cancellation_cases.assigned_to`

Manager assignment by policy should update all open records for the same carrier_key + normalized policy.

Do not rewrite closed historical rows unless current code requires owner display consistency and doing so is safe/auditable.

### 4.4 Bootstrap migration

Backfill shared ownership from existing domain rows before enabling auto assignment.

Conflict handling:
- same policy, same current owner in both domains -> bootstrap that owner
- only one domain assigned -> bootstrap that owner
- renewal/cancellation assigned to different employees -> do not guess; create manager-review conflict row/event and leave shared owner unresolved until manager chooses

Never resolve an existing conflict by workload balancing.

---

## 5. Employee assignment settings

Recommended table:

`policy_followup_agent_settings`

```sql
create table public.policy_followup_agent_settings (
  profile_id uuid primary key references public.profiles(id),
  renewals_enabled boolean not null default true,
  cancellations_enabled boolean not null default true,
  auto_assignment_enabled boolean not null default true,
  assignment_mode text not null default 'producer_preferred'
    check (assignment_mode in ('automatic', 'producer_preferred', 'manual_only')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Eligibility also requires:
- profile active
- role eligible under existing Policy Follow-up permissions
- correct domain enabled
- not manual-only for auto balancing

Do not connect this setting to quote queue status, attendance status, RingCentral turn, WhatsApp turn, or workload rotation positions.

---

## 6. Weighted assignment engine

### 6.1 One scoring definition

Implement weights in one place. Recommended shared TypeScript constants plus equivalent SQL config/table only if the server assignment engine needs it.

Prefer a small DB configuration table when assignment runs entirely in SQL:

`policy_followup_workload_weights(key text primary key, points integer not null)`

Seed the defaults from Requirements 4.2. Manager editing of weights is not required in this phase.

### 6.2 Server-side score

Recommended RPC:

`policy_followup_agent_workload(p_profile_id uuid, p_business_date date)`

or one batched function returning every eligible profile.

Score only open, assigned records.

Renewal scoring inputs:
- renewal date
- next follow-up
- source state / non-renewal flag
- closed outcome

Cancellation scoring inputs:
- cancellation effective date
- next follow-up/escalation deadline
- case status
- communication status / manual follow-up need
- verification state

### 6.3 Auto assignment RPC

Recommended RPC:

`policy_followup_auto_assign(p_domain text, p_record_id uuid, p_business_date date)`

Transaction flow:
1. lock/select source record;
2. normalize identity;
3. check shared owner;
4. check producer mapping;
5. determine eligible profiles;
6. calculate full current score;
7. select deterministic minimum;
8. upsert owner with `weighted_auto`;
9. update domain record;
10. write domain audit event and shared ownership audit if added;
11. return owner + source + score snapshot.

Use advisory locks or row locks as appropriate so concurrent imports cannot double-decide from stale state.

---

## 7. Operational projection

### 7.1 Shared type

```ts
export type PolicyWorkDomain = 'renewal' | 'cancellation';
export type PolicyUrgencyBucket = 'critical' | 'today' | 'upcoming' | 'waiting' | 'later';

export interface PolicyWorkItem {
  domain: PolicyWorkDomain;
  sourceId: string;
  carrier: string | null;
  policyNumber: string;
  customerName: string;
  assignedTo: string | null;
  assignedName: string | null;
  eventDate: string | null;
  daysRemaining: number | null;
  normalizedStatus: string;
  nextAction: string | null;
  actionDueDate: string | null;
  lastContactAt: string | null;
  waitingReason: string | null;
  urgency: PolicyUrgencyBucket;
  workloadPoints: number;
  reviewRequired: boolean;
  communicationBlocked: boolean;
}
```

### 7.2 Renewal adapter

Use existing `derive.ts` and extend it rather than reimplementing all renewal rules.

Fix the current empty-contact-index limitation with a bulk contact summary read such as:

`listRenewalContactSummaries(recordIds?: string[])`

Return at least:
- record_id
- last_contact_at
- contact_count
- last_outcome

If requote activity is required for next-action accuracy, add a bulk requote/event summary as well.

### 7.3 Cancellation adapter

Use existing row states and `deriveNextRequiredAction` / `primaryAction`.

The work projection must not produce a different next action than the cancellation table/drawer for the same role/state.

### 7.4 Urgency derivation

Recommended precedence:

`critical` if:
- action overdue; OR
- active cancellation <=3 days and employee action is required; OR
- renewal is carrier non-renewal requiring requote and no requote activity; OR
- communication failure requires manual action.

`today` if current action due today.

`upcoming` if current action due within 7 days.

`waiting` if waiting on a recorded dependency and no action due today/overdue.

`later` otherwise for active assigned work.

Closed items are excluded from My Work.

---

## 8. My Work UI

### 8.1 PolicyFollowUpPage

Extend the current shell to support URL-driven view selection while preserving direct renewals/cancellations routes/query links.

Recommended views:
- My Work
- Renewals
- Cancellations
- Manager Overview (manager only)
- Imports (manager only)

On an agent's first Policy Follow-up visit, default to My Work.

### 8.2 Layout

Top summary:
- Critical count
- Today count
- Upcoming count
- Waiting count

Then render the selected bucket as compact rows/cards.

Avoid a spreadsheet-like 20+ column layout.

Suggested row:

```text
[CANCELLATION · 2 DAYS]  ABC Trucking
Progressive · Policy 123456
Next: Call Customer
Last contact: Aug 11 · Next follow-up: Today
```

or

```text
[RENEWAL · NON-RENEWAL]  XYZ Logistics
National General · Policy 987654
Next: Prepare Requote
Renewal: Sep 3
```

### 8.3 Opening work

Clicking a work item opens the existing domain drawer, not a new duplicate detail modal.

If the current shell cannot host both drawers easily, use a route/search-param state that renders the correct existing drawer component.

---

## 9. Drawer changes

### 9.1 Renewal drawer

At the top add one concise operational header:
- status chip
- Next Action
- renewal date / days remaining
- assignee
- last contact
- next follow-up

Add/retain actions appropriate to current state.

Put source/import data under a secondary disclosure.

### 9.2 Cancellation drawer

Preserve existing cancellation action engine, payment panel, verification panel, contact panel, communication history, note/evidence composer.

Only reorganize the top so Next Action and urgency are obvious.

Do not remove manager-only action restrictions.

---

## 10. Manager Overview design

### 10.1 Aggregate API

Do not compute full manager KPIs from only the rendered renewal/cancellation page windows.

Recommended server RPC:

`policy_followup_manager_overview(p_business_date date)`

Return:

```ts
interface PolicyFollowUpManagerOverview {
  renewals: DomainOverviewCounts;
  cancellations: DomainOverviewCounts;
  attention: AttentionCounts;
  agents: AgentWorkloadSummary[];
}
```

At minimum include full-population counts required by REQ-9.

### 10.2 Attention cards

Each attention card includes a filter target:

```ts
{
  id: 'cancellations-overdue',
  label: 'Cancellations overdue',
  count: 8,
  target: { tab: 'cancellations', filter: 'needs-action', extra: 'overdue' }
}
```

Use existing saved filters where possible. Add a narrowly scoped filter only when current filters cannot represent the category.

### 10.3 Team table

Rows sorted by highest risk first by default:
1. overdue count descending;
2. critical count descending;
3. workload score descending;
4. display name ascending.

Click employee -> filter My Work/manager detail to that employee.

---

## 11. Import integration design

### 11.1 Renewal importer

Add collector schema detection beside legacy Power BI support.

New collector rows must not be mislabeled as `assignment_source = 'powerbi'`.

Add explicit collector source metadata and source-aware update logic.

After upsert, call owner resolution only for records without a protected/shared owner.

### 11.2 Cancellation importer

Add canonical single-file collector import beside the legacy eficacia/avisos path.

Legacy import remains available under a secondary/collapsed action during transition.

`pending` -> source facts + active case
`paid_signal` -> stop future cancellation reminders, move to verification flow
`cancelled_signal` -> resolve only if identity unambiguous

### 11.3 Import summary assignment section

After preview/commit show:
- preserved existing owners
- producer-mapped assignments
- weighted-auto assignments
- unassigned/review-required
- ownership conflicts

---

## 12. Manager assignment controls

Add a manager Policy Follow-up settings area with two sections:

### Agent Eligibility
Per profile:
- renewals toggle
- cancellations toggle
- auto-assignment toggle
- mode

### Producer Mapping
Reuse existing renewal/cancellation mapping data where practical. If two separate mapping systems exist, create a shared UI adapter before creating a third table.

Manager record reassignment should expose:
- current owner
- assignment source
- lock status
- reassign select
- unlock automatic assignment (explicit action)

---

## 13. Auditing

Recommended shared table if repository lacks a suitable generic audit table:

`policy_followup_assignment_events`

Fields:
- id
- carrier_key
- policy_number_normalized
- domain/source record id nullable
- event_type (`bootstrap`, `producer_assignment`, `auto_assignment`, `manager_assignment`, `unlock`, `conflict`)
- previous_profile_id
- next_profile_id
- actor_profile_id
- detail jsonb
- created_at

Domain audit events should still be written so existing drawers/history remain complete.

---

## 14. Permissions/RLS

Use current `canAccessRenewals` / `isBroadManagerRole` conventions.

RLS principles:
- broad manager roles read/manage shared owner/settings rows;
- agents may read shared owner rows needed to display their authorized cases but cannot reassign/lock;
- new manager overview RPC verifies role server-side;
- auto-assignment RPC cannot be invoked to assign arbitrary unrelated profiles by a normal agent.

Do not expose service-role credentials in the client.

---

## 15. Testing strategy

### Pure-function tests
- Spanish/raw status normalization
- carrier key normalization
- renewal next-action precedence
- urgency bucket precedence
- workload points boundaries
- deterministic tie breaking

### Import tests
- exact renewal collector schema detection
- exact cancellation collector schema detection
- re-import idempotency
- source field update does not reset operational fields
- `No renueva` -> carrier non-renewal / critical requote
- probable/no-match -> review block
- paid/cancelled cancellation signals

### Assignment tests
- manager locked owner preserved
- existing shared owner preserved
- existing domain owner bootstraps shared owner
- producer map wins before balancing
- weighted balancing picks lowest score
- manual-only excluded
- domain-disabled employee excluded
- concurrent calls do not corrupt ownership
- cross-domain owner sync
- existing renewal/cancellation ownership conflict -> review, not guess

### UI/derivation tests
- renewal list uses real bulk contact summary
- My Work buckets
- cancellation shared item action equals existing cancellation action engine
- manager full-scope counts
- attention card drill-down target

### Regression
- cancellation scheduler/suppression/payment/verification tests
- renewal requote workflow tests
- Policy Follow-up role/access tests
- quote rotation and attendance/queue status tests unaffected

---

## 16. Deployment sequence

1. Baseline current branch: typecheck, tests, lint, build.
2. Add additive migrations for source metadata, shared ownership, agent settings, audit, RPCs.
3. Backfill shared ownership from existing records with conflict report.
4. Add collector importer support with auto assignment disabled behind a feature/config flag if practical.
5. Add bulk renewal contact summaries and shared work projection.
6. Add My Work.
7. Add Manager Overview.
8. Add manager eligibility/reassignment controls.
9. Validate with sanitized fixtures and local uncommitted real collector files.
10. Enable weighted auto assignment only after manager reviews bootstrap conflicts and eligible-agent settings.
11. Keep customer automatic messaging OFF until its existing domain readiness checks pass; this feature must not toggle it on.

Rollback/disable must be able to stop auto assignment without deleting imported data or ownership history.
