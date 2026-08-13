# Requirements: policy-follow-up-assignment-workflow

## 0. Purpose, scope, and precedence

This spec is the current implementation target for integrating the existing Renewal and Cancellation collector outputs into New Hope Work Desk and turning those imported policy facts into clear, accountable employee work.

It is an **incremental extension and hardening pass**, not a rebuild.

Preserve and reuse the existing:
- `PolicyFollowUpPage`
- Renewals module (`src/features/renewals/*`)
- Cancellations module (`src/features/cancellations/*`)
- renewal import/history/requote workflow
- cancellation case, communication, suppression, payment, verification, scheduler, notes/evidence, and audit infrastructure
- manager assignment alias/mapping logic where it is already correct
- RLS and role boundaries

This spec **supersedes the earlier local `policy-collector-integration` proposal where the two conflict**. If that integration has not yet been implemented, implement its canonical collector-file support as part of this spec. If some of it has already been implemented, inspect the repository first and implement only the missing pieces.

Do not rebuild carrier scraping inside Work Desk. The desktop collector programs remain the data collection layer.

Target operating model:

`Carrier portals -> existing collector programs -> one canonical CSV per domain -> Work Desk -> assignment -> employee actions -> communications -> outcomes -> management reporting`

The main goal is not merely successful CSV upload. The main goal is that:
1. source files may remain Spanish and carrier-specific;
2. Work Desk normalizes them into one operational vocabulary;
3. every active policy/case has clear ownership or a visible manager exception;
4. agents see a short, understandable list of work and one next step at a time;
5. managers can see pending, overdue, unassigned, risky, and overloaded work without reading a spreadsheet.

---

## 1. Source data normalization and language boundary

### REQ-1.1: Preserve raw source values

The original collector values must remain available for audit. Never replace the raw Spanish/carrier value with the normalized value in the source payload.

Store or retain, where applicable:
- raw source row/payload
- source filename
- source row number
- source carrier value
- raw carrier status/type value
- collector match status and method
- collector warning text
- import run id

### REQ-1.2: Normalize before operational use

Agents and managers must not need to interpret Spanish collector column names or carrier-specific status wording to perform work.

Map imported values into stable internal concepts. Examples:

| Source concept/value | Operational concept |
|---|---|
| Renovación / renewal row | Renewal |
| No renueva | Carrier Non-Renewal / Requote Required |
| Cancelación pendiente | Pending Cancellation |
| Pagada / paid signal | Payment Reported / Verification Required |
| Cancelada / cancelled signal | Cancelled |
| Prima | Premium |
| Productor | Producer / Assignment Source |
| Asegurado / Titular | Customer / Named Insured |

Do not implement this as a UI-only translation of raw text. Persist normalized machine-readable fields or derive them through one tested normalization module.

### REQ-1.3: Unknown values are exceptions, not guesses

An unrecognized source status/type must:
- still import when identity requirements are met;
- preserve the raw value;
- be marked `Review Required` or equivalent;
- be excluded from automatic customer communication until reviewed;
- appear in Manager Overview attention counts.

### REQ-1.4: Contact/match confidence safety

Rows with unreliable HawkSoft/customer matching must remain visible, but they must not automatically communicate with a customer.

At minimum support:
- Exact / reliable match -> eligible for normal workflow
- Probable / review match -> manager review before automatic communication
- No Match / unmatched -> manager review; no automatic communication

Manual manager authorization may clear the communication block without changing the preserved source match result.

---

## 2. Canonical collector file support

### REQ-2.1: Renewals collector contract

Recognize the current 26-column Renewals consolidated CSV without manual mapping:

`Compania, Poliza, PolizaNormalizada, Asegurado, LOB, TerminoMeses, FechaRenovacion, FechaVencimiento, FechaProcesada, PrimaRenovacion, PrimaAnterior, TipoRegistro, EstadoEnReporte, ClienteID, Titular, Telefonos, Emails, EstadoHawkSoft, ActivaEnHawkSoft, PrimaHawkSoft, Productor, Cruce, MetodoCruce, ArchivoOrigen, FilaOrigen, AvisosImportacion`

The production-like sample previously evaluated had 1,118 rows, including ordinary renewal and `No renueva` rows. Do not hard-code those counts into production logic; use them only as a local validation reference if the file is available outside version control.

### REQ-2.2: Cancellation collector contract

The PendingCancellation collector must produce one Work Desk export:

`consolidado_cancelaciones_YYYYMMDD_HHMMSS.csv`

using UTF-8-SIG and the canonical headers:

`Compania, Poliza, PolizaNormalizada, Asegurado, LOB, FechaCancelacion, FechaCancelacionEstimada, FechaVencimientoPago, MontoAdeudado, TipoTransaccion, EstadoCarrier, TipoRegistro, ClienteID, Titular, Telefonos, Emails, EstadoHawkSoft, Productor, Idioma, Cruce, MetodoCruce, ArchivoOrigen, FilaOrigen, AvisosImportacion`

`TipoRegistro` machine values:
- `pending`
- `paid_signal`
- `cancelled_signal`

If the collector source is not in the Kiro workspace, implement Work Desk against this contract and produce the collector export patch separately.

### REQ-2.3: Import preview and confirmation

Before mutation, manager preview must show at minimum:
- detected domain/source
- file name
- total rows
- create/update/unchanged/rejected counts
- duplicate identities inside file
- carrier distribution
- exact/probable/no-match counts
- missing phone/email
- unmatched producer labels
- unassigned cases after proposed assignment
- review-required rows
- renewal non-renewal count
- estimated cancellation dates
- cancellation paid/cancelled signal counts

No database mutation before confirmation.

### REQ-2.4: Safe re-import

Uploading the same file twice must not duplicate:
- policy/case rows
- ownership rows
- contacts
- follow-up actions
- alerts
- customer communications
- audit business events

A later import updates source-owned policy facts but must preserve employee-owned operational history.

### REQ-2.5: Absence is not an outcome

A row missing from a later file does not prove payment, renewal, cancellation, or loss.

Renewals may flag missing-from-latest-source for review. Cancellations must never resolve from absence alone.

---

## 3. Shared policy ownership model

### REQ-3.1: Assign policies, not spreadsheet rows

Ownership must be stable across import runs and across Renewal/Cancellation domains.

Use a shared policy ownership identity based on:
- normalized carrier key
- normalized policy number

Do not use customer name alone.

A renewal cycle and cancellation case may remain separate domain records, but they should normally resolve to the same policy owner.

### REQ-3.2: Shared ownership record

Add a shared ownership layer (table or equivalent authoritative model) that can represent:
- carrier key
- normalized policy number
- assigned profile id
- assignment source
- assignment lock/protection state
- assigned by
- assigned at
- last auto-assigned at
- optional manager note

Existing `renewal_records.assigned_to` and `cancellation_cases.assigned_to` may remain for compatibility, but writes must stay synchronized with the shared policy owner.

### REQ-3.3: Assignment precedence

For every new or newly-unowned policy, evaluate assignment in this exact order:

1. **Protected manager assignment** — if a manager locked/overrode ownership, preserve it.
2. **Existing shared policy owner** — retain the owner across reimports and across renewal/cancellation records.
3. **Existing valid domain owner during migration** — bootstrap the shared owner from a valid current `assigned_to` value rather than reassigning.
4. **Producer alias/mapping** — if the imported `Productor` reliably maps to an active eligible employee, assign that employee.
5. **Weighted workload balancing** — assign an unowned, reliable record to the eligible employee with the lowest workload score.
6. **Manager Review** — if no eligible employee exists, producer identity is ambiguous, match confidence blocks automatic handling, or required identity data is uncertain, leave the record visibly unassigned/review-required.

No import may silently override a protected or existing owner.

### REQ-3.4: Manager assignment modes per employee

Managers must be able to configure each active employee for Policy Follow-up with:
- Renewals: eligible yes/no
- Cancellations: eligible yes/no
- Automatic assignment: yes/no
- Assignment mode: `automatic`, `producer_preferred`, or `manual_only`

`manual_only` employees receive no automatic balancing assignment.

Existing application roles remain authoritative for access; these settings only control workload eligibility.

### REQ-3.5: Manager reassignment

Managers can assign/reassign a policy to an active eligible profile.

Manager reassignment must:
- update the shared policy owner;
- update active renewal/cancellation records for that same policy where appropriate;
- create audit events in affected domains;
- identify previous/new owner and actor;
- become protected from future automatic re-import reassignment until manager explicitly unlocks or changes it.

### REQ-3.6: No agent self-stealing

Do not create a general claim/steal behavior for assigned policies.

Unassigned work may optionally expose `Claim` only if management explicitly enables it later. This spec defaults to manager/automatic ownership, not queue stealing.

---

## 4. Weighted workload balancing

### REQ-4.1: Workload is based on required work, not raw policy count

Do not distribute simply by number of policies.

The workload calculation must incorporate urgency and required actions. An employee with 40 urgent cancellations may be more loaded than an employee with 70 renewals due in 45 days.

### REQ-4.2: Default workload weights

Implement one tested default scoring model. Keep weights in one shared configuration/constants location so UI and assignment logic cannot drift.

Initial default weights:

#### Renewal
- open renewal >30 days with no due follow-up: 1
- renewal due within 30 days: 2
- due within 15 days: 3
- due within 7 days: 4
- due within 3 days: 5
- Carrier Non-Renewal / Requote Required: 7
- overdue required follow-up: +5

#### Cancellation
- active cancellation >15 days: 2
- due within 15 days: 3
- due within 10 days: 4
- due within 5 days: 6
- due within 1 day or today: 10
- payment/verification required: 7
- failed/manual communication requiring employee action: +4
- overdue required follow-up: +5

Resolved/closed records contribute 0.

### REQ-4.3: Automatic assignment transaction safety

Automatic balancing must be performed server-side or through a transaction-safe RPC so two simultaneous imports/actions do not select the same "lowest workload" employee based on stale client state.

Tie break deterministically, for example:
1. lowest workload score;
2. oldest `last_auto_assigned_at`;
3. stable profile id.

### REQ-4.4: Manager visibility into the score

Managers must see per employee:
- active policies/cases
- actions due today
- overdue actions
- critical cancellations
- renewal non-renewals/requotes
- waiting items
- workload score

Agents do not need to see the numeric score unless later requested.

### REQ-4.5: Rebalancing is never automatic for already-owned work

Workload scoring determines assignment of unowned work. It must not continuously move already-owned policies among agents.

A manager can use workload information to manually rebalance.

---

## 5. One clear current action per active record

### REQ-5.1: Operational projection

Create one shared operational projection that can represent both domains as a work item without replacing the underlying domain records.

Each projected item must include at least:
- domain: renewal/cancellation
- source record id
- carrier
- policy number
- customer
- assigned employee
- policy event date (renewal/cancellation)
- days remaining
- current normalized status
- next required action
- next action due date when applicable
- urgency bucket
- waiting state
- workload points
- match/review block indicators

This may be a database RPC/view plus TypeScript adapter, or another repository-consistent implementation. Do not create a second independent lifecycle database.

### REQ-5.2: Renewal next-action ladder

Reuse/extend the current `recommendedNextAction` model. The user-facing workflow must resolve to one clear primary action.

Priority order:
1. closed outcome -> no active action / `Closed`
2. Carrier Non-Renewal or requote required and no requote started -> `Prepare Requote`
3. requote prepared/sent and customer decision not recorded -> `Follow Up on Requote` or `Record Customer Decision` as appropriate
4. no contact recorded -> `Make First Contact`
5. scheduled/overdue follow-up exists -> `Complete Follow-up`
6. customer contacted but renewal terms not reviewed -> `Review Renewal`
7. final decision ready -> `Record Customer Decision`
8. otherwise -> `Complete Follow-up`

Do not force agents to select a raw database status to discover what to do.

### REQ-5.3: Cancellation next-action ladder

Reuse the existing `deriveNextRequiredAction` / primary action implementation as the cancellation source of truth.

Do not create a parallel cancellation next-action engine.

The shared My Work view must display the same action that the Cancellation drawer displays.

### REQ-5.4: Renewal list contact defect must be fixed

The current Renewals list uses an empty contact index at page level, which causes list-level `No contact recorded`, `Last contact`, and recommended next action to be inaccurate.

Add a bulk/read-efficient contact summary path so the Renewals list and shared work view use real contact history.

Do not issue one network query per row.

### REQ-5.5: Action completion produces history

Completing/logging an action must create the appropriate domain event/contact/communication record and recalculate the next action.

Imports update source facts; they do not erase completed actions or restart the workflow.

---

## 6. Agent experience: My Work

### REQ-6.1: Add My Work as the agent-first surface

Extend Policy Follow-up with a `My Work` view aggregating assigned Renewals and Cancellations.

For agents, `My Work` is the default Policy Follow-up landing view.

Existing direct URLs to Renewals/Cancellations must remain functional.

### REQ-6.2: Work buckets

Group assigned open work into these buckets:

#### Critical
Includes at minimum:
- overdue required action
- cancellation within 3 days requiring employee action
- carrier non-renewal/requote required with no requote started
- communication failure requiring manual action

#### Today
Required action due today and not already Critical.

#### Upcoming
Required action in the next 7 days and not Critical/Today.

#### Waiting
No employee action is currently due because the item is waiting on customer, payment, verification, or another recorded dependency.

#### Later
Active assigned policy with no required action in the next 7 days.

### REQ-6.3: Default density

The My Work screen must be compact. It should answer:
- Who is the customer?
- What policy/carrier?
- Renewal or cancellation?
- How urgent is it?
- What do I do next?

Do not expose raw Spanish column names or a 20-column imported spreadsheet by default.

### REQ-6.4: Work item card/row

At minimum show:
- urgency/domain label
- customer
- carrier
- policy number
- event date + days remaining
- next required action
- last contact summary
- next follow-up/due date

Primary click opens the existing domain drawer.

### REQ-6.5: Action-oriented drawer

The existing Renewal/Cancellation drawers remain authoritative detail surfaces.

At the top of each drawer show:
- current normalized status
- prominent `Next Action`
- event date/days remaining
- assigned employee
- most recent contact
- next follow-up

Then show action buttons relevant to that next step.

Imported/source details remain available under a secondary `Source Data` or `Imported Data` disclosure rather than dominating the agent workflow.

---

## 7. Renewal workflow requirements

### REQ-7.1: Standard workflow

Operationally support:

`Upcoming -> Contact Required -> Customer Contacted -> Renewal Review -> Renew As-Is OR Requote -> Customer Decision -> Renewed/Lost`

Do not require adding exactly these strings as database statuses if the existing schema can represent them safely through status + events + flags.

### REQ-7.2: Carrier non-renewal

`TipoRegistro = No renueva` or normalized equivalent must:
- remain open;
- display `Carrier Non-Renewal` prominently;
- force `Prepare Requote` ahead of ordinary renewal actions;
- appear in Critical work;
- never automatically mark the business Lost.

### REQ-7.3: Follow-up logging

Renewal follow-up must capture at minimum:
- channel
- direction
- outcome
- notes
- occurred at
- evidence where supported
- next follow-up date

The existing contact/evidence model should be reused.

### REQ-7.4: Final outcome

Closing a renewal requires a deliberate outcome:
- Renewed
- Lost
- Cancelled / no longer applicable when existing workflow supports it

Record actor, timestamp, and outcome reason where available.

---

## 8. Cancellation workflow requirements

### REQ-8.1: Standard workflow

Operationally support:

`New/Imported -> Contact Customer -> Waiting/Follow-up -> Payment Reported -> Verification -> Reinstated`

or

`New/Imported -> Contact Customer -> Follow-up -> Cancelled`

Reuse current cancellation statuses and panels rather than replacing them.

### REQ-8.2: Urgency dominates display

Cancellation effective date and pending action must drive urgency. A cancellation due tomorrow must outrank a routine renewal even if both were imported at the same time.

### REQ-8.3: Estimated cancellation date

An estimated date must:
- display `Estimated` visibly;
- be Manager Review / communication-safety gated as defined by collector integration;
- not trigger automatic customer messaging until confirmed under the existing sending safety rules.

### REQ-8.4: Explicit carrier signals

`paid_signal` and `cancelled_signal` update the related case only when identity is unambiguous.

Ambiguous signals go to Import Review.

A paid signal stops future cancellation reminders and moves to verification/reinstatement handling rather than silently closing the case.

---

## 9. Manager Overview

### REQ-9.1: Manager-first operational dashboard

Managers need a different surface from agents.

Add `Manager Overview` under Policy Follow-up, visible to `manager` and `super_admin` (or repository-equivalent broad manager gate).

It must answer: **What is at risk or falling behind?**

### REQ-9.2: Domain overview metrics

Show at minimum for Renewals and Cancellations:
- Active
- Need action today
- Overdue
- Unassigned
- Never contacted / no successful contact as domain-appropriate
- Waiting
- Completed this month

Also show:
- Carrier Non-Renewal / Requote Required
- Payment verification required
- failed communications
- review-required imports/matches

### REQ-9.3: Attention Required section

Surface actionable exception cards such as:
- overdue cancellations
- overdue renewals
- unassigned policies
- unmatched producer labels
- match-review rows
- carrier non-renewals awaiting requote
- cancellation payment verification
- failed SMS/email
- missing valid contact
- unknown imported status

Each count must be clickable into the underlying records with the corresponding filter applied.

### REQ-9.4: Team workload table

Show one row per eligible employee:
- active renewal count
- active cancellation count
- due today
- overdue
- critical
- waiting
- workload score

Allow manager drill-down by employee.

### REQ-9.5: Correct counts over the full scope

Manager metrics must not pretend a client-side loaded window is the whole dataset.

If current cancellation pagination/windowing is capped, implement aggregate RPCs or server-side counts that evaluate the full manager-readable population.

---

## 10. Detailed policy views and search

### REQ-10.1: Keep detailed domain lists

Keep the existing Renewals and Cancellations detailed list views for search, filtering, audit, and bulk management.

### REQ-10.2: Cross-domain policy search

Add a simple Policy search surface or search capability in My Work/Manager Overview that can find by:
- customer name
- policy number
- carrier
- phone/email where existing permissions allow

Results should show whether the policy currently has:
- active renewal
- active cancellation
- both
- neither (only historical record, when supported)

### REQ-10.3: Same policy owner across domains

If both a renewal and cancellation exist for the same carrier + normalized policy, display one consistent owner unless a documented exception prevents synchronization.

---

## 11. Manager Imports surface

### REQ-11.1: Imports remain manager-only

Add/retain an Imports surface where managers can:
- upload Renewal collector file
- upload Cancellation collector file
- see recent import runs
- review errors/exceptions
- inspect unmatched producers
- inspect probable/no-match records
- inspect unknown statuses

### REQ-11.2: Import does not equal assignment completion

The import result summary must distinguish:
- imported successfully
- assigned by existing owner
- assigned by producer
- assigned by workload balancing
- left unassigned/review-required

### REQ-11.3: Source lineage visible to managers

For any record, managers can inspect source filename/row, raw status/type, match status/method, and import warning.

---

## 12. Notifications and communications

### REQ-12.1: Do not duplicate domain messaging engines

Cancellation continues using its existing communication/scheduler/suppression engine.

Renewal uses the existing renewal contact/RingCentral work and any implemented renewal messaging extension.

The shared My Work/Manager Overview only consumes status; it does not become a second sender.

### REQ-12.2: Automatic communication eligibility

Automated customer communication is blocked when:
- match confidence requires review;
- contact is invalid/suppressed;
- cancellation date is estimated where prohibited;
- status is review-only/unknown;
- domain auto-send is disabled;
- the exact touchpoint already succeeded.

### REQ-12.3: Internal manager alerts

Generate/deduplicate internal alerts for high-value exceptions such as:
- item remains unassigned after import
- critical item has no successful contact
- overdue follow-up
- non-renewal has no requote activity
- payment verification waiting too long
- final SMS/email failure

Do not spam managers with one alert per refresh.

---

## 13. Audit and data ownership

### REQ-13.1: Source-owned vs human-owned fields

Collector/import may update source-owned facts such as:
- carrier status
- event dates
- premium/amount
- source lineage
- HawkSoft match information
- customer contact facts from source

Collector/import must not overwrite human-owned operational facts such as:
- protected assignment
- notes
- evidence
- completed contact history
- manual communication authorization
- next follow-up entered by staff unless an explicit source rule owns it
- outcome entered/verified by staff

### REQ-13.2: Assignment audit

Every assignment source must be attributable:
- existing owner
- producer mapping
- weighted auto assignment
- manager assignment
- migration/bootstrap

Manager UI should display assignment source in details.

### REQ-13.3: No PII fixtures in repository

Do not commit real collector CSVs or customer PII. Build sanitized synthetic fixtures matching the real headers and edge cases.

---

## 14. Navigation and role behavior

### REQ-14.1: Policy Follow-up navigation

Support URL-addressable views without breaking existing links. Recommended query values:
- `?tab=my-work`
- `?tab=renewals`
- `?tab=cancellations`
- `?tab=manager`
- `?tab=imports`

Agents default to `my-work`.
Managers default to `manager` or `my-work` according to the simplest repository-consistent implementation, but Manager Overview must be one click away.

### REQ-14.2: Role visibility

Agents:
- My Work
- assigned policy details
- actions allowed by each domain

Managers/super-admin:
- everything agents can access
- Manager Overview
- Imports
- assignment settings/mappings
- reassign/unlock ownership

Do not weaken database/RLS access just to make UI counts easier.

---

## 15. Performance and correctness

### REQ-15.1: No N+1 reads for contact summaries

Renewal contact summaries and shared work projection must use bulk queries/RPCs/joins.

### REQ-15.2: Full-scope metrics

Dashboard counters must be based on the full authorized population, not only the first 50/1000 rows rendered.

### REQ-15.3: Business date

Continue using `America/New_York` business-date semantics already established in renewal/cancellation derivations.

### REQ-15.4: Deterministic derivation

Urgency, workload score, next action, and normalized status mapping must live in tested pure functions or stable SQL functions with one authoritative definition per concern.

---

## 16. Acceptance criteria

The spec is complete only when all of the following are true:

1. A manager uploads a valid renewal collector file and valid cancellation collector file without manual column mapping.
2. Raw Spanish/source values remain auditable while operational UI uses normalized language.
3. Re-importing the same file does not duplicate business state or reset employee progress.
4. Existing manager assignments remain unchanged through imports.
5. New reliable unowned policies follow assignment precedence and weighted balancing.
6. Uncertain records are visible in Manager Review and are not auto-communicated.
7. Agents open Policy Follow-up and immediately see a compact My Work list grouped by urgency.
8. Every open item displays one clear next action and opens the existing domain drawer to perform it.
9. Renewal list-level contact/next-action calculations use real bulk contact history, not an empty placeholder.
10. `No renueva` becomes Critical Requote Required, not Lost.
11. Cancellation paid signals move to verification; cancelled signals resolve only on unambiguous identity.
12. Managers can see overdue, today, unassigned, no-contact, review-required, failed-communication, and workload-by-agent metrics across the full population.
13. Manager metric cards drill into the actual records.
14. Assigning/reassigning a policy updates both active domains for that policy and is auditable.
15. Automatic assignment never continuously rebalances already-owned work.
16. No existing quote rotation/availability behavior is changed.
17. Existing cancellation messaging safety, suppressions, verification, and scheduler behavior still passes regression tests.
18. `npx tsc --noEmit`, test suite, lint, and production build pass or baseline pre-existing failures are separately documented.
