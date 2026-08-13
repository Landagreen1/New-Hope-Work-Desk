# Tasks: policy-follow-up-assignment-workflow

## Execution rule

Work through phases in order. Before changing code, inspect the current repo and mark any task already satisfied by newer work as `already satisfied` with evidence. Do not re-implement a feature that current code already provides correctly.

Do not commit real customer collector files.

---

## Phase 0 — Baseline and repository audit

- [ ] 0.1 Read current `.kiro` specs, especially `cancellations-operational-hardening`, `policy-follow-up-renewals-cancellations`, and `renewal-sms-ringcentral`.
- [ ] 0.2 Inspect current Renewals/Cancellations pages, drawers, derive modules, APIs, migrations, RLS, importers, manager actions, scheduler, and tests.
- [ ] 0.3 Run `npx tsc --noEmit`, tests, lint, and production build; record pre-existing failures separately.
- [ ] 0.4 Document current Renewal and Cancellation assignment sources/mapping logic before changes.
- [ ] 0.5 Confirm the current Renewals list-level contact defect: `RenewalsPage` uses an empty contact index; record the exact current behavior/tests that will change.
- [ ] 0.6 Create only sanitized synthetic collector fixtures using the real canonical headers.

## Phase 1 — Collector source normalization

- [ ] 1.1 Add/verify exact detection for the 26-column Renewal collector file.
- [ ] 1.2 Add/verify canonical single-file Cancellation collector contract and importer; preserve legacy eficacia/avisos as secondary during transition.
- [ ] 1.3 Create one tested normalization module for raw Spanish/carrier source values -> normalized operational source state.
- [ ] 1.4 Persist raw source status/type and normalized state without losing source lineage.
- [ ] 1.5 Add/verify match-confidence fields and automatic-communication review block.
- [ ] 1.6 Ensure unknown source values import as Review Required rather than guessed.
- [ ] 1.7 Ensure `No renueva` normalizes to Carrier Non-Renewal / Requote Required and remains open.
- [ ] 1.8 Verify absence from a later file never resolves an outcome automatically.
- [ ] 1.9 Add preview counts required by REQ-2.3.
- [ ] 1.10 Add idempotent re-import regression tests.

## Phase 2 — Shared policy ownership foundation

- [ ] 2.1 Add forward-only migration for `policy_followup_policy_owners` or repository-equivalent shared ownership model.
- [ ] 2.2 Add one canonical carrier-key normalization function and tests.
- [ ] 2.3 Add forward-only migration for `policy_followup_agent_settings`.
- [ ] 2.4 Add assignment audit table if no suitable existing generic audit table exists.
- [ ] 2.5 Add RLS/policies for new shared tables using current manager/agent permission conventions.
- [ ] 2.6 Implement ownership bootstrap from existing renewal/cancellation assignments.
- [ ] 2.7 Detect cross-domain owner conflicts and output manager-review rows; never auto-resolve conflicts.
- [ ] 2.8 Implement `policy_followup_assign_policy` manager-safe assignment RPC/service.
- [ ] 2.9 Implement explicit unlock of manager-protected ownership.
- [ ] 2.10 Mirror shared owner to active renewal/cancellation domain records safely.
- [ ] 2.11 Add tests proving import does not override protected/shared owners.

## Phase 3 — Weighted workload engine

- [ ] 3.1 Add one authoritative workload weight configuration/constants implementation using REQ-4.2 defaults.
- [ ] 3.2 Implement renewal workload scoring and boundary tests (30/15/7/3 days, non-renewal, overdue follow-up).
- [ ] 3.3 Implement cancellation workload scoring and boundary tests (15/10/5/1 days, verification, communication failure, overdue follow-up).
- [ ] 3.4 Closed/resolved records score zero.
- [ ] 3.5 Implement full eligible-agent workload query/RPC.
- [ ] 3.6 Implement transaction-safe auto assignment with assignment precedence.
- [ ] 3.7 Exclude inactive, wrong-domain, auto-disabled, and manual-only profiles.
- [ ] 3.8 Producer mapping must win before weighted balancing.
- [ ] 3.9 Implement deterministic tie break.
- [ ] 3.10 Add concurrency/idempotency tests.
- [ ] 3.11 Ensure auto assignment never rebalances already-owned policies.

## Phase 4 — Integrate ownership with importers

- [ ] 4.1 Renewal import: preserve existing/shared owner first; then producer; then weighted balance; then review.
- [ ] 4.2 Cancellation import: same precedence.
- [ ] 4.3 Import result/preview shows proposed/preserved assignment source counts.
- [ ] 4.4 Manager manual assignment is locked against future auto import.
- [ ] 4.5 Same policy across active Renewal/Cancellation records resolves to the same shared owner.
- [ ] 4.6 Ambiguous/missing identity or unreliable match remains visible and unassigned/review-required where required.
- [ ] 4.7 Confirm no assignment path changes WhatsApp/RingCentral/workload quote rotations or attendance queue status.

## Phase 5 — Fix renewal contact projection

- [ ] 5.1 Add a bulk renewal contact summary API/RPC; no per-row N+1 query.
- [ ] 5.2 Include contact count, last contact timestamp, and last relevant outcome.
- [ ] 5.3 Add bulk requote/event summary if needed for accurate next-action derivation.
- [ ] 5.4 Remove the empty-contact-index placeholder behavior from Renewal list derivation.
- [ ] 5.5 Update summary counts (`No contact recorded`), Last Contact cells, and recommended next action to use real contact history.
- [ ] 5.6 Add regression tests demonstrating the corrected list behavior.

## Phase 6 — Shared operational work projection

- [ ] 6.1 Add shared Policy Work types.
- [ ] 6.2 Create Renewal -> PolicyWorkItem adapter using existing renewal derive logic.
- [ ] 6.3 Extend renewal next-action ladder for Carrier Non-Renewal and Review Renewal without breaking existing requote flow.
- [ ] 6.4 Create Cancellation -> PolicyWorkItem adapter using existing `deriveNextRequiredAction`/`primaryAction`.
- [ ] 6.5 Assert in tests that cancellation shared next action equals the existing drawer/list action.
- [ ] 6.6 Implement Critical/Today/Upcoming/Waiting/Later urgency derivation.
- [ ] 6.7 Calculate per-item workload points from the same authoritative weights.
- [ ] 6.8 Exclude closed/resolved items from My Work.

## Phase 7 — My Work agent experience

- [ ] 7.1 Extend Policy Follow-up URL/tab state with `my-work` while preserving existing direct Renewals/Cancellations links.
- [ ] 7.2 Agents default to My Work.
- [ ] 7.3 Add summary counters for Critical, Today, Upcoming, Waiting.
- [ ] 7.4 Add compact work rows/cards with domain, urgency, customer, carrier, policy, event date/days, next action, last contact, next follow-up.
- [ ] 7.5 Default order: Critical first; then due/overdue action date; then policy event date; then customer name.
- [ ] 7.6 Clicking a work item opens the existing Renewal or Cancellation drawer.
- [ ] 7.7 Add loading/error/retry behavior consistent with current module patterns.
- [ ] 7.8 Keep raw/import source fields out of the primary agent list.
- [ ] 7.9 Test that an agent sees only authorized/assigned work under existing RLS/read scope.

## Phase 8 — Drawer operational headers

- [ ] 8.1 Renewal drawer: add concise operational header with normalized status, Next Action, renewal date/days, owner, last contact, next follow-up.
- [ ] 8.2 Renewal drawer: source/import details moved to or retained under secondary disclosure.
- [ ] 8.3 Cancellation drawer: make existing Next Action/urgency/owner/contact information prominent without changing its action engine.
- [ ] 8.4 Preserve cancellation payment, verification, contact, communication, note/evidence panels and manager-only action restrictions.
- [ ] 8.5 Verify action completion recalculates My Work classification on refresh.

## Phase 9 — Manager Overview

- [ ] 9.1 Add server-side/full-scope `policy_followup_manager_overview` RPC/service.
- [ ] 9.2 Add `Manager Overview` URL/tab, manager/super-admin only.
- [ ] 9.3 Show Renewal/ Cancellation Active, Today, Overdue, Unassigned, No Contact, Waiting, Completed This Month.
- [ ] 9.4 Show Carrier Non-Renewal/Requote Required, Payment Verification, Failed Communication, Review Required.
- [ ] 9.5 Add Attention Required cards with clickable drill-down to underlying records.
- [ ] 9.6 Add team workload table with renewal/cancellation counts, today, overdue, critical, waiting, workload score.
- [ ] 9.7 Employee row click filters relevant work for that employee.
- [ ] 9.8 Ensure all counts cover full authorized population and are not limited by cancellation loaded-window cap.
- [ ] 9.9 Add manager overview tests against synthetic data larger than one page/window.

## Phase 10 — Manager assignment/settings UI

- [ ] 10.1 Add Policy Follow-up Agent Eligibility settings UI.
- [ ] 10.2 Managers can toggle Renewals/Cancellations eligibility, auto assignment, and assignment mode.
- [ ] 10.3 Reuse existing producer mapping UI/data where possible; do not create a third conflicting mapping system.
- [ ] 10.4 Add policy reassignment control showing current owner/source/lock.
- [ ] 10.5 Reassignment updates all active same-policy domain records and logs audit events.
- [ ] 10.6 Add explicit `Unlock automatic assignment` action with confirmation/clear explanation.
- [ ] 10.7 Add manager filter for ownership conflicts and unassigned/review-required policies.

## Phase 11 — Imports manager surface

- [ ] 11.1 Add/extend `Imports` URL/tab for manager-only access.
- [ ] 11.2 Present Renewal collector upload and Cancellation collector upload as primary paths.
- [ ] 11.3 Keep legacy imports secondary/collapsed during transition.
- [ ] 11.4 Show recent import runs and row-level exception counts.
- [ ] 11.5 Show assignment result counts: existing owner, producer mapping, weighted auto, review/unassigned.
- [ ] 11.6 Expose source filename/row, raw source state, normalized interpretation, match result, warnings for manager audit.

## Phase 12 — Notifications and communication safety

- [ ] 12.1 Confirm shared My Work/Manager Overview does not send customer communication itself.
- [ ] 12.2 Preserve cancellation communication/scheduler/suppression engine.
- [ ] 12.3 Preserve renewal communication/RingCentral behavior already implemented.
- [ ] 12.4 Enforce review/match/contact/estimated-date blocks before automatic sends.
- [ ] 12.5 Add/deduplicate internal manager exception alerts for unassigned critical, overdue no-contact, non-renewal no requote, verification aging, and final send failure.
- [ ] 12.6 Do not enable customer automatic sending as part of this spec.

## Phase 13 — Reporting and audit validation

- [ ] 13.1 Verify every assignment/reassignment has assignment source and actor audit.
- [ ] 13.2 Verify import updates source facts without erasing human workflow history.
- [ ] 13.3 Verify same-policy ownership consistency across domains.
- [ ] 13.4 Add manager-readable assignment source and source-data detail.
- [ ] 13.5 Add basic completion metrics by agent/domain if current reporting architecture already has a natural extension point; do not rebuild the reporting center in this spec.

## Phase 14 — Security, regression, and deployment

- [ ] 14.1 Review new tables/RPCs against RLS and `isBroadManagerRole`/Policy Follow-up access rules.
- [ ] 14.2 Verify agents cannot alter shared owner/settings except through explicitly permitted actions.
- [ ] 14.3 Verify service-role secrets remain server-only.
- [ ] 14.4 Run synthetic renewal and cancellation imports twice; prove no duplicate rows/owners/actions/messages.
- [ ] 14.5 Run a changed-file reimport; prove source facts update and notes/history/owner remain.
- [ ] 14.6 Test existing-owner, producer-map, workload-auto, and manager-review assignment paths.
- [ ] 14.7 Test one policy appearing in both domains.
- [ ] 14.8 Test owner conflict bootstrap.
- [ ] 14.9 Test agent My Work and manager full-scope overview.
- [ ] 14.10 Run `npx tsc --noEmit`.
- [ ] 14.11 Run full tests.
- [ ] 14.12 Run lint.
- [ ] 14.13 Run production build.
- [ ] 14.14 Produce migration order, deployment checklist, rollback/disable-auto-assignment steps, files changed, and exact test results.
- [ ] 14.15 Deploy/validate with automatic customer sending unchanged/off unless it was already explicitly enabled in production by a manager.

---

## Definition of done

Do not call this complete because the CSVs upload or because assignment rows exist.

Complete means:
- collector files import safely;
- source Spanish is normalized for operations but preserved for audit;
- stable policy ownership exists;
- assignment precedence is correct;
- weighted assignment is transaction-safe;
- agents have a clean My Work experience with one next action;
- managers have full-population pending/overdue/unassigned/workload visibility;
- same-policy cross-domain ownership is consistent;
- reimports do not reset work;
- communication safety remains intact;
- regression/typecheck/lint/build validation succeeds.

---

# Completion record

Implemented as an incremental extension of the existing Renewals and Cancellations modules. Neither
module was rebuilt; no carrier scraping was added to Work Desk.

## Already satisfied before this pass (not re-implemented)

Inspected first, per the execution rule, and left alone:

| Task | Already provided by |
|---|---|
| 5.3 cancellation next-action ladder | `cancellations/domain/communication-status.deriveNextRequiredAction`, wrapped by `derive.primaryAction`. Consumed, never re-expressed. |
| 8.4 cancellation panels and manager-only restrictions | `CancellationPaymentReport`, `CancellationVerificationPanel`, `CancellationContactPanel`, note/evidence composer, `MANAGER_ONLY_ACTIONS`. Untouched. |
| 12.2 cancellation communication/scheduler/suppression engine | `scheduler/run.ts`, `scheduler/send.ts`, `domain/suppression.ts`, `render/gate.ts`. Untouched. |
| 12.3 renewal RingCentral behaviour | `api.sendRenewalSms`, `/api/renewals/sms/*`. Untouched. |
| 10.3 producer mapping | `renewal_assignment_aliases`, the agency's one mapping, already reused by the cancellation importer. Reused again rather than a third table. |
| 11.3 legacy imports | Power BI wizard in `RenewalManagerActions`, eficacia/avisos wizard in `CancellationManagerActions`. Both unchanged and still reachable. |
| 14.1 URL tab state | `?tab=` already existed; extended from two ids to five without renaming either existing id. |

## Deliberate design decisions worth re-reading before changing this

1. **`renewalNormalizedStatus` lives in `renewals/derive.ts`, not in the shared projection.** The
   Renewal drawer needs it, and putting it in `policy-follow-up/work-projection.ts` would have made
   the drawer depend on the cancellations module. `work-projection.ts` re-exports it.
2. **`cancellationWorkItem` calls `primaryAction` for every Case_Status, not only active ones.** An
   `Invalid` or `Duplicate` case is inactive but still owes somebody `Mark Resolved`, and the drawer
   offers exactly that. Gating it would have hidden real work and contradicted the drawer. Only the
   *imminent-cancellation* critical clause is restricted to active cases.
3. **`renewal_contact_summaries` and `renewal_requote_summaries` are SECURITY INVOKER.** Row level
   security on `renewal_contacts` and `renewal_events` already limits a non-manager to their own
   records; running as the caller reuses that rule instead of restating it. A post-condition asserts
   neither function is `SECURITY DEFINER`.
4. **`policy_followup_workload_rows` is revoked from `public`, `anon`, and `authenticated`.** Supabase
   default privileges grant execute on new public functions to the two client roles, so revoking from
   `PUBLIC` alone is not enough. Requirement 4.4 gives the score to managers.
5. **v1.13.6's `cancellation_import_batch` body is generated, not hand-written.** Re-run
   `generate-collector-import-fn.mjs` and re-embed if v1.10.10 ever changes; it asserts the branch
   counts so a moved anchor fails loudly.
6. **The legacy eficacia classifier now disallows `PolizaNormalizada`.** A collector export carries
   `Poliza` and `FechaCancelacion` and would otherwise classify as eficacia and be merged with the
   wrong field ownership.
7. **Carrier keys are never merged on fuzzy similarity.** `Progresive` keys to itself. A visible
   duplicate a manager can correct beats a silent cross-carrier ownership link.

## Validation

Four SQL harnesses in this folder, run with `node scripts/run-sql.mjs`. Each seeds synthetic data,
asserts, then raises a `…PASSED` exception caught by its own handler, so the whole subtransaction
rolls back and nothing persists — verified by counting rows afterwards.

| Harness | Covers |
|---|---|
| `validate-assignment-engine.sql` | all six Requirement 3.3 precedence steps, cross-domain owner sync, reimport idempotency, and that balancing never moves owned work |
| `validate-bootstrap-conflicts.sql` | the four design 4.4 cases, that an import refuses to pick a side on a conflict, that a manager decision settles and locks it, and idempotency |
| `validate-manager-overview.sql` | every Requirement 9.2 counter over 71 open renewals and 121 active cancellations — past both the 50-row page and the 1,000-row client window — plus team workload, bulk contact summaries, cross-domain search, and the ownership exception list |
| `validate-collector-import.sql` | both collector exports, double-import idempotency, staff work preserved, closed renewal preserved, Requirement 8.4 paid signal, assignment-by-source counts, and that both legacy cancellation paths still own exactly their fields |

## Not done, on purpose

* Automatic customer messaging was not enabled. `cancellation_settings.automatic_sending_enabled`
  was `false` before this work and is `false` after it (Requirement 12.6).
* No quote rotation, turn position, availability column, or attendance queue state was read or
  written. Policy Follow-up eligibility shares no storage with queue eligibility.
* Weighted auto-assignment is reachable but assigns nobody until a manager enables at least one
  employee in Manager Overview → Ownership → Agent eligibility. Deploying changes no one's book.
