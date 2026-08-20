# Specialty Quotes Engine — Implementation Record

Trucking and Homeowners collaborative quoting. Delivered against the Specialty Quotes
Engine specification, sections 1–102.

Migrations `v1.16.0` … `v1.16.7` are applied to the live project. The application code
is on the branch named at the end of this document.

---

## 1. Architecture chosen, and why

**A generic engine with two configured lines, not two applications.**

Three decisions shaped everything else.

**Team membership is the authorization axis.** The database had no team concept at all —
only role-based scoped supervisors. Rather than invent `trucking_agent` and
`homeowners_agent` roles, which would have hard-coded the agency's staffing into the
`app_role` enum, access is granted by rows in `quoting_team_members`. Every predicate in
the engine reads those rows, so changing who handles a line of insurance is a manager
action, not a migration. Oscar and Jason are `super_admin`, Brenda is
`customer_service`, and all three are ordinary members; no role changed for anyone.

**Assignment is accountability, never access.** Not one row-level policy in the engine
tests `primary_assignee_id = auth.uid()`. Read access is `specialty_can_view_opportunity`
and write access is `specialty_can_edit_opportunity`, both of which resolve through team
membership. The assignee is consulted in exactly one place — a team that has switched
`collaborative_editing` off — and the migration asserts that fact about itself by
scanning `pg_policies` at the end of its own transaction. This is the single behaviour
the existing Commercial Board gets wrong and the reason the engine exists.

**The intake is the source of truth for the customer.** An opportunity stores workflow,
assignment, marketing, pricing, tasks and results. Customer name, phone, DOT, MC,
property address, drivers and vehicles stay on `cs_intake_submissions` and are read
through `source_intake_id`. The one denormalised column is `display_name`, because a card
needs a title and a legacy-adopted opportunity has no intake to read one from. When a
specialty member needs to correct a VIN or a roof age, `specialty_update_intake` writes
to the original intake — so Customer Service and the specialty team can never disagree
about a phone number.

Consequences worth naming: the nine stages are one shared vocabulary rather than
per-template state machines, so stage counts and cross-line reporting have one meaning;
and `commercial_gl` is permitted by every check constraint but routed nowhere, so a
Commercial Team can be created later without a schema change.

---

## 2. Database migrations

Applied in order with `node scripts/run-sql.mjs <file>`. Each ends in a `do $post$` block
that queries `pg_policies` / `pg_proc` / `information_schema` to prove it did what it
claimed, and raises to roll the whole file back if not.

| Migration | What it adds |
|---|---|
| `v1.16.0-specialty-quoting-teams.sql` | Quoting teams, members with six capabilities, LOB routing, workflow templates + stages + checklist templates, carrier registry, authorization helpers, RLS, seeds |
| `v1.16.1-specialty-opportunities.sql` | The opportunity and seven child tables, indexes, storage bucket and policies, 25 RLS policies, transition-column guard trigger |
| `v1.16.2-specialty-mutations.sql` | 24 security-definer transition RPCs |
| `v1.16.3-specialty-reads.sql` | Row-shaping view plus search, counts, detail, timeline, workspace context, teams admin |
| `v1.16.4-specialty-reports.sql` | Seven reporting functions |
| `v1.16.5-specialty-intake-routing.sql` | Specialty submit path, two commercial guards, Quote Center overlay, Customer Service callback |
| `v1.16.6-specialty-legacy-adoption.sql` | Adoption of legacy Trucking/Homeowners commercial cards |
| `v1.16.7-specialty-read-fixes.sql` | Two read functions that could not execute (see §14) |

---

## 3. New tables, views and RPCs

**Tables.** `quoting_teams`, `quoting_team_members`, `quoting_team_lob_routes`,
`quoting_team_events`, `specialty_workflow_templates`, `specialty_workflow_stages`,
`specialty_checklist_templates`, `specialty_carriers`, `specialty_opportunities`,
`specialty_carrier_markets`, `specialty_checklist_items`,
`specialty_information_requests`, `specialty_notes`, `specialty_documents`,
`specialty_price_presentations`, `specialty_activity`.

**Columns added to existing tables.** `commercial_quotes.migrated_to_specialty_at` and
`commercial_quotes.migrated_to_specialty_id`, both nullable and additive.

**Views.** `specialty_opportunity_rows` — one row per opportunity with its carrier
roll-up, outstanding information, checklist progress and prioritisation flags, revoked
from `authenticated`. `quote_center_journeys` was rebuilt with three appended columns
(`specialty_opportunity_id`, `specialty_reference`, `specialty_information_needed`) using
`create or replace`, because `quote_center_journey()` returns `setof` that view and
dropping it would have taken the function with it.

**Transitions.** `specialty_claim_opportunity`, `specialty_reassign_opportunity`,
`specialty_update_opportunity`, `specialty_update_intake`, `specialty_change_stage`,
`specialty_add_note`, `specialty_add_checklist_item`,
`specialty_toggle_checklist_item`, `specialty_add_information_request`,
`specialty_resolve_information_request`, `specialty_register_document`,
`specialty_add_carrier_market`, `specialty_update_carrier_market`,
`specialty_remove_carrier_market`, `specialty_record_price_sent`,
`specialty_record_result`, `specialty_clear_result`.

**Team administration.** `specialty_team_save`, `specialty_team_save_member`,
`specialty_team_remove_member`, `specialty_team_set_route`.

**Reads.** `specialty_search_opportunities`, `specialty_stage_counts`,
`specialty_opportunity_detail`, `specialty_activity_timeline`,
`specialty_workspace_context`, `specialty_teams_admin`.

**Reports.** `specialty_report_pipeline`, `specialty_report_workload`,
`specialty_report_contributions`, `specialty_report_timing`,
`specialty_report_carrier_performance`, `specialty_report_lost_business`,
`specialty_report_attention`.

**Intake and Customer Service.** `cs_intake_submit_specialty`, `specialty_cs_status`,
`specialty_cs_provide_information`, `specialty_cs_add_note`.

**Internal, not granted to clients.** `specialty_log`, `specialty_lock_for_edit`,
`specialty_advance_stage`. The activity writer in particular must not be reachable from a
browser, or history could be forged; the migration asserts the grants.

---

## 4. RLS and permission changes

Helpers, each mirrored by a named function in `src/features/specialty/permissions.ts`:
`specialty_is_manager`, `specialty_member_capability`, `specialty_can_access`,
`specialty_can_view_lob`, `specialty_can_view_opportunity`,
`specialty_can_edit_opportunity`, `specialty_can_claim_opportunity`,
`specialty_can_reassign_opportunity`, `specialty_can_view_reports`.

RLS is enabled with at least one policy on all eight specialty tables, and every child
table's policies are scoped through the parent opportunity — securing the opportunity
while leaving carrier markets or notes readable would have defeated the boundary
entirely.

Deliberate omissions, each of which is a decision rather than an oversight:

- **No insert policy on `specialty_opportunities`.** Opportunities are born from the
  intake routing RPC, the adoption migration, or a manager action — all security
  definer. Nothing creates one from a browser.
- **No delete policy on `specialty_opportunities`.** Deleting one would delete its
  history. Work is closed by recording Not Sold with a reason.
- **No update or delete policy on `specialty_notes`.** Nobody rewrites another
  employee's history, including a manager.
- **No insert, update or delete policy on `specialty_activity`.** Inserts arrive only
  from the definer RPCs.
- **Select only on `specialty_price_presentations`.** What the customer was told is a
  fact.
- **No delete on a submitted carrier market.** It is withdrawn, not erased.

A trigger, `specialty_guard_protected_columns`, refuses a direct `UPDATE` that touches
stage, assignment, team, result, lost reason, sold premium, bound carrier, or any of the
lifecycle timestamps. Those transitions must go through the RPCs that validate them,
stamp the timestamps and write the audit row; a raw `PATCH` from a client would skip all
three.

Storage: a private `specialty-quote-documents` bucket with select/insert/delete policies
gated by `specialty_can_access_document_object`, which validates the leading path segment
as a UUID *as text* before casting, so a crafted object name denies rather than raises.
No update policy, so an upload with `upsert: true` fails by design. A further permissive
select policy on `commercial-quote-attachments` lets a specialty team read the legacy
attachments its adopted opportunity references; the existing commercial storage policies
are untouched.

Super-admin parity holds throughout: every predicate that admits `manager` admits
`super_admin`, and there is a test asserting it.

---

## 5. Quoting Team implementation

`quoting_teams` carries name, description, active flag, `assignment_method`
(`shared_claim`, `manual_assignment`, `automatic_balanced`, `round_robin`),
`collaborative_editing`, and `team_visibility` (`team` or `agency`).

`quoting_team_members` carries six per-member capabilities — view, claim, edit, be
assigned, reassign, view reports — plus `is_active`, `added_by`, `removed_at`,
`removed_by`, `removed_reason`. Membership is retired, never deleted, so historical
attribution survives.

`quoting_team_lob_routes` answers "where does a submitted intake go", with a partial
unique index enforcing exactly one active default destination per line of business.

Two safety behaviours are enforced server-side and surfaced in the UI:

- Removing a member who still holds active assignments is refused until a transfer target
  is named, and then each opportunity is transferred with a full audit trail. Nothing is
  ever silently stranded.
- A team cannot be deactivated while it is the only active destination for a routed line.
  The error names the affected lines.

Only `shared_claim` is wired into the claim path today. The other three modes are
accepted and stored so a team can be configured ahead of the behaviour existing, and
`specialty_claim_opportunity` refuses a self-claim on a `manual_assignment` team rather
than pretending the setting has no effect.

---

## 6. Team configuration instructions

**User Administration → Quoting Teams**, available to Manager and Super Admin.

Already configured by the `v1.16.0` seed:

| Team | Line | Members | Assignment | Collaborative editing |
|---|---|---|---|---|
| Trucking Team | Trucking | Oscar, Jason | Shared Claim | Enabled |
| Homeowners Team | Homeowners | Oscar, Jason, Brenda | Shared Claim | Enabled |

The seed resolved those three by `username` (`oscar`, `jason`, `brendam`), not by display
name — there are two "Brenda Morales" profiles and one is deactivated. If a username had
been missing the migration would have logged a notice and skipped that member rather than
guessing.

To add a member: open the team, pick any active employee from **Add a member**. Their
application role is irrelevant — a Customer Service rep and a Super Admin can both be
ordinary members of the same team. They gain access immediately.

To change who receives a line: change the receiving team in the **Line-of-business
routing** table. Existing opportunities keep their team; only new submissions follow the
new route.

To create a Commercial Team later: create the team, add members, add a
`commercial_gl` workflow template, then set the `commercial_gl` route. No authorization
code changes. There is an integration test that creates a team, adds a member, and proves
that member's access appears — with no code change — precisely so this claim is not taken
on trust.

Leave **Collaborative editing** on. Turning it off restricts editing to the primary
assignee, which is the behaviour this engine was built to replace.

---

## 7. Intake-routing changes

Customer Service keeps using the existing intake forms. No new Trucking form, no new
Homeowners form.

`cs_intake_submit_specialty(p_submission_id)` resolves the active default route for the
line, creates one opportunity owned by that team, seeds the workflow checklist, leaves it
**unclaimed**, notifies every member who can claim, marks the intake `converted`, and
writes a `converted_specialty` intake event. It is idempotent per intake, so a
double-click or a retried request returns the opportunity that already exists. It touches
no rotation.

Customer Service is no longer asked for an assignee on Trucking or Homeowners. The form
says so, and the assignee selector is replaced with an explanation. Commercial GL still
requires one, because a commercial card is created for one person.

Two independent guards stop Trucking and Homeowners reaching the Commercial Board, because
one path is not enough:

1. `cs_intake_submit_commercial`'s line-of-business whitelist was narrowed to
   `commercial_gl`. It was rewritten in place from the live definition using
   `pg_get_functiondef` + `replace`, so the twelve-thousand-character description builder,
   checklist seeding, column history and activity logging that Commercial GL depends on
   are provably unchanged. The migration asserts they survived.
2. A `before insert` trigger on `commercial_quotes` refuses any card whose
   `coverage_type` names a line Specialty Quotes now owns. This is path-independent, so it
   holds for any future caller.

The stale one-argument `cs_intake_submit_commercial(uuid)` overload was dropped. It
ignored the assignee and silently picked the first active manager.

---

## 8. Legacy Trucking/Homeowners migration approach

**Specification section 79, Option C, with a permanent adapter.**

Inspection first: Trucking and Homeowners intakes have been creating `commercial_quotes`
rows since `v1.6.0`, identified only by `coverage_type`. The live population was two
rows — one live homeowners card and one soft-deleted trucking card. Option A would have
moved production data to save nothing; Option B would have touched every commercial
policy and RPC for the sake of two rows.

So each live card is **adopted**:

- The commercial row and every child stay exactly where they are. Nothing is deleted, no
  timestamp is lost.
- A specialty opportunity is created pointing back at the card, carrying the card's
  original `created_at`, its assignee (kept only if that person is actually an eligible
  member of the receiving team, otherwise the work arrives unclaimed and visible, which is
  recoverable), and a stage mapped from `board_column`.
- When the card came from a CS intake, the opportunity points at that intake too, so the
  customer's Quote Center journey stays continuous.
- Comments become notes, checklist items become checklist items, column history and the
  activity log become timeline entries — all with their original authors and timestamps.
  The card's flattened `description`, which was the only place the original intake detail
  reached the commercial side, is preserved as the first note.
- Attachments are **referenced, not copied**. The document row keeps
  `storage_bucket = 'commercial-quote-attachments'`, and a storage policy lets the owning
  team read those objects. Moving files between buckets would have risked them to gain
  nothing.
- The card is stamped `migrated_to_specialty_at`, and the commercial list and timing
  endpoints filter on it. The row is still there for anyone who needs the history; it
  simply stops being live in two places.

Soft-deleted legacy cards are **not** adopted. They were already off the board; adopting
one would resurrect deleted work into a live queue.

Result: 1 card adopted as `SQ-92CCBE47`, with its assignee (Brenda) preserved and its
intake linked. 1 soft-deleted card left untouched. 0 Commercial GL cards affected. The
migration asserts, per card, that no comment, attachment or checklist item was lost.

---

## 9. UI structure, and why

**One module. Three destinations.** No Trucking board, no Homeowners board, no separate
databases or queues.

- **Work** — the operational surface. Opens on all of the team's active work.
- **Quotes** — search and browse everything, closed included.
- **Reports** — pipeline, attention, workload, contribution, timing, carriers, lost
  business.

Quoting Teams lives under User Administration, because it is a settings screen and making
it a fourth quoting destination would put an admin screen in front of people who never
open it.

**A prioritised list rather than a nine-column board.** The workflow has nine stages, an
employee works two lines at once, and the point of the module is that a teammate's quote
is as reachable as your own. Nine full-width columns on a laptop cannot show a next
action, a due date, an assignee and carrier progress at the same time, and a board makes
"what needs attention across every stage" the hardest question to ask instead of the
easiest. So stage is a filter and a badge, the saved views are the prioritisation, and the
row carries everything section 59 requires: customer, line, stage, assignee, next action,
due state, last activity, and a carrier summary of the form "3/5 submitted · 2 quotes
received".

Above the list sits a **needs-attention strip** — unclaimed, overdue, due today, waiting
on carrier, options not sent, no recent activity — so nobody searches to find out what
needs doing.

**All Team Work is the default view.** Assigned to Me is offered beside it as a workload
filter, never as an access boundary.

**The detail is a side drawer**, reusing `SideDrawer` from Time & Attendance — the only
focus-trapped overlay in the codebase, so it is the accessible choice as well as the fast
one. An employee opens a quote while the customer is on the line, and losing the list
behind them is a worse trade than a narrower panel. Above the fold, before scrolling: who
the customer is, what kind of quote, who is accountable, the stage, the next action and
its due state, what information is missing, and how far along the carriers are. Six tabs
below: Overview, Customer & Intake, Carrier Markets, Documents, Notes & Tasks, Activity.
Actions are context-aware — anything that does not apply right now is absent rather than
disabled.

Implementation notes: styled exclusively with the existing `ui` token object, no new
colours, no new component library. `ModuleShell` for the frame, `DatePicker` /
`DateTimePicker` / `DollarInput` for inputs, inline `ui.error` / `ui.success` banners for
feedback since `RoleWorkspace` provides no toast. Data access follows Quote Center:
debounced load, server-side paging, `Promise.all(rows, counts)`, and a request token so a
slow earlier response cannot overwrite a newer one.

Every quote row carries a **Log** action. Because a specialty opportunity has no work item
— its work never enters the sales queue — the Customer Service `QuoteActivityModal`, which
is keyed on `source_work_item_id`, cannot represent it. `SpecialtyLogModal` is the
equivalent surface: same purpose, same visual language, reading
`specialty_activity_timeline`, which already merges the opportunity's history with the
intake's event log and the shared notes.

Files: `src/features/specialty/` — `types.ts`, `status.ts`, `permissions.ts`, `api.ts`,
`workflow.ts`, `application.ts`, `timeline.ts`, `list-state.ts`, `SpecialtyWorkspace.tsx`,
`SpecialtyList.tsx`, `SpecialtyReports.tsx`, `QuotingTeamsAdmin.tsx`,
`SpecialtyLogModal.tsx`, and `workspace/` for the routed quote page. Registered in
`app-sidebar.tsx`, `sidebar-layout.tsx` and `role-workspace.tsx`, and routed at
`src/app/specialty-quotes/`.

The quote detail was a side drawer (`OpportunityDrawer.tsx`) until v1.20.0. It is now a
routed full-screen workspace at `/specialty-quotes/[quoteId]` — see the Workspace section
below for why, and `workspace/QuoteWorkspace.tsx` for the component that replaced it.

One shell change worth flagging: Specialty Quotes is the first module whose visibility a
role cannot answer, so `getModulesForRole`, `resolveNavigationForRole` and `AppSidebar`
now take an optional `ModuleAccess` flag. `RoleWorkspace` asks the database once via
`specialty_can_access()` and passes the answer down, so the sidebar, the navigation
resolver and the content router cannot disagree and bounce a member out of the module they
just opened.

---

## 10. Carrier-market implementation

One opportunity, many carrier markets, `unique (opportunity_id, carrier_id)`. A
five-carrier trucking quote is one record with five children, not five quotes.

Each market carries its own status (nine values), who is handling it, submission date and
submitter, last action and actor, carrier follow-up date, premium, down payment, payment
terms, deductible, coverage notes, quote-received date and recorder, decline reason,
information requested, notes, documents, and `presented_at`.

Validation lives in the table and again in the RPC, so the message names the missing thing
rather than surfacing a constraint violation: Quote Received needs a premium, Declined
needs a reason, More Information Needed needs the request. The client mirrors these in
`carrierStatusRequires` so the form can say what is missing before the round trip.

Submission and quote-receipt timestamps are stamped the first time a status says so, and
later edits do not move them — the pipeline timings depend on when it actually happened.
The opportunity's stage follows what the markets are doing: the first submission moves it
to Marketing, the first received quote to Options Ready.

Collaboration is the point. Jason submits Progressive, Oscar submits Canal, Jason records
one premium, Oscar records the other, and each activity row names whoever actually acted.
There is an integration test asserting exactly that, including that `submitted_by` and
`quote_received_by` end up as two different people on the same market.

A submitted market cannot be deleted — it is set to Withdrawn, so the marketing history
survives. An unapproached one can be removed.

Price comparison sorts the viable quotes by premium and marks the lowest, showing premium,
down payment, terms, deductible, coverage notes and whether each has been sent. It is a
human quoting workspace, not a comparative rater.

---

## 11. Collaboration and concurrency implementation

**Claiming is atomic.** `specialty_claim_opportunity` takes `for update` on the row
*before* reading the assignee, so two members clicking Claim at the same moment serialise:
one wins, the other gets "This quote has already been claimed by Jason." — and the quote
remains fully visible and editable to both. A re-claim by the same person is a no-op, not
an error.

**A stale save is refused, not merged.** Every mutating RPC takes
`p_expected_version` and raises SQLSTATE `40001` on a mismatch, matching
`cs_intake_save_draft` so the client recognises a conflict the same way it already does for
shared intake drafts. The UI shows a conflict banner, reloads, and says plainly that
nothing the teammate did was lost. Carrier markets and the linked intake carry their own
version counters, checked independently.

**No optimistic updates anywhere.** The server decides, the client refetches. That is the
house pattern, and here it is load-bearing: several people work the same quote, so a
locally-applied change would be the silent overwrite the concurrency rules exist to
prevent.

**Freshness without a reload.** The list subscribes to `postgres_changes` on
`specialty_opportunities` and `specialty_carrier_markets`, polls every 60 seconds, and
refreshes on focus, reconnect and tab return — the same four mechanisms the Intake Queue
uses. Realtime is a notification to refetch, never a source of data: the row the server
returns has already been through the team boundary and a payload has not.

**Attribution.** `specialty_log` always writes `auth.uid()`. It is revoked from
`authenticated`, so history cannot be forged, and the migration asserts the revoke. When a
result is recorded, the audit row carries the actor *and* the primary assignee as separate
facts, because reporting needs both and must never infer one from the other.

---

## 12. Quote Center changes

`quote_center_journeys` gained a specialty overlay. The lifecycle expressions now test the
specialty branch *before* the commercial branch, so a legacy-adopted intake — which still
carries its `source_commercial_quote_id` — reports where the work actually is now. Stage,
label, assignee, price-sent date, finalised date, decision and last activity are all taken
from the opportunity when there is one, and the specialty reference is searchable.

The nine specialty stages map onto Quote Center's four existing buckets, and the
employee-facing labels are the normalized set section 81 asks for: Submitted to Specialty
Team, Information Needed, Being Quoted, Options Ready, Price Sent, Customer Follow-Up,
Sold, Not Sold. That CASE exists in three places — the view, `specialty_cs_status`, and
`normalizedLifecycleStatus` in TypeScript — and a parity test pins all three together so a
customer's status cannot read differently depending on which surface asked.

`SpecialtyStatusPanel` in the journey drawer gives Customer Service what they need and
nothing more: the normalized status, who is accountable, the outstanding information items
the team chose to share, and the shared notes. Carrier markets, premiums and decline
reasons are absent by construction — `specialty_cs_status` only selects
`visible_to_cs` items and `is_cs_visible` notes, so the boundary is in SQL rather than in
what a component happens to render.

The callback works end to end: CS sees "Loss runs" outstanding, presses **I have this**,
says what arrived, and `specialty_cs_provide_information` marks the item received, writes
the specialty timeline, adds a shared note, and — if nothing else is outstanding — moves
the quote back to Ready to Market. No new intake, no lost context. Internal items are
refused to CS with a clear reason.

---

## 13. Reporting implementation

Seven aggregate RPCs, each gated by `specialty_can_view_reports()` and each scoped by the
same per-row team boundary as the operational list, so a Homeowners-only member's figures
contain no Trucking numbers. Nothing is computed in the browser from a full table pull.

Pipeline, Needs Attention, Workload, Contribution, Timing, Carrier Performance, Lost
Business.

Two presentation decisions:

**Workload and Contribution are separate views.** Workload counts primary assignments;
Contribution counts what people actually did, from `specialty_activity`. Merging them
would reintroduce the exact mistake the engine exists to avoid — crediting the assignee
for a teammate's carrier submission. The Contribution table is raw and unweighted, offered
as operational visibility rather than as a score.

**A metric with no underlying data reads as "—", never as zero.** A carrier never
submitted to has no quote rate; saying 0% would be a claim about the carrier rather than
about our records. Timing averages exclude stages that have not happened rather than
counting them as zero, and every interval is between two server-stamped columns.

---

## 14. Tests added

**`__tests__/team-access.test.ts`** — 60 tests, `fast-check` property tests included. The
access rules as executable claims: membership not role, Brenda denied Trucking while
admitted to the module, a non-member refused everything, a manager admitted without
membership, retired members and deactivated teams and deactivated employees each
disqualifying on their own, capability withdrawal, and super-admin parity. The central
property: **for every possible assignee — a teammate, a stranger, or nobody — a
collaborative member's read and write access is unchanged.** If that ever fails, the
engine has regressed to the model it replaced.

**`__tests__/migration-parity.test.ts`** — 34 tests. Vocabulary parity between
`status.ts` and the CHECK constraints (stages, carrier statuses, lost reasons, document
categories, price methods), plus the structural guarantees: no assignee-gated policy, RLS
on every child table, append-only history, the lock-before-read ordering in the claim
path, the transition-column guard, outcome discipline, the routing guards, the adoption
losing nothing, the reads being gated, and — checking function bodies with comments
stripped — that nothing in the engine touches a queue rotation.

**`__tests__/specialty-workflow.integration.test.ts`** — 57 tests against the live
project, using `set local request.jwt.claims` impersonation so RLS applies as each
employee. Covers every mandatory acceptance scenario: routing and intake linkage,
idempotency, notification fan-out, both commercial guards, the Commercial GL regression,
per-employee visibility including Brenda-denied-Trucking with `rls_rows = 0`, child-table
RLS for three different people, the claim race with the winner named, team-wide editing
with correct attribution, the stale-save refusal, the raw-update refusal, the
information-needed loop through Customer Service and back, carrier-market CRUD and every
validation, the frozen price snapshot surviving a later premium correction, Sold and Not
Sold with their required fields, manager-only reopening, audited reassignment, contribution
crediting the actor, the Quote Center overlay, the legacy adoption preserving everything,
and a brand-new team granting access with no code change. Cleanup is by marker, before and
after, so a failed run leaves the next one a clean slate.

**Two production bugs were found by the integration suite on its first run**, neither
reachable by a unit test because both are properties of the database rather than of the
SQL text. Both are fixed in `v1.16.7`:

1. `specialty_opportunity_detail` raised `54023`, *cannot pass more than 100 arguments to
   a function*, for **any opportunity with a linked intake** — that is, every quote created
   from an intake. The intake payload was one `jsonb_build_object` with 56 key/value pairs,
   which is 112 arguments against a cap of 100. The detail drawer would not have opened at
   all. Now built as three concatenated chunks producing the same object.
2. `specialty_report_contributions` raised `42702`, *column reference "profile_id" is
   ambiguous*. A `RETURNS TABLE` column is also a PL/pgSQL variable, so the CTE column of
   the same name could not be resolved and the whole Contribution report failed. Every CTE
   column is now named so it cannot collide with an output parameter.

The `v1.16.7` post-condition impersonates a real team member so it reaches the SQL that
was broken — both errors are raised while *planning* the body, which happens after the
access gate, so a post-condition that only tripped the gate would have proved nothing.

Also changed: `npm run test:integration` now passes `--no-file-parallelism`. Integration
suites share the Supabase Management API and were throttling each other; the specialty
suite additionally serialises its own requests behind a 350 ms gap with exponential-backoff
retry on 429. A throttle is not a result — every assertion in that suite reads an error
message, so a 429 would otherwise masquerade as a refusal and pass.

---

## 15. Typecheck result

`npx tsc --noEmit` — **clean, no errors.** (There is no `typecheck` npm script in this
project; `tsc --noEmit` is the equivalent.)

## 16. Lint result

`npm run lint` — **exit code 0.**

Stated precisely, because it matters: ESLint prints `react-hooks/set-state-in-effect`
errors, and it printed them before this work too. They are the project-wide
`void load()`-in-an-effect pattern used by `QuoteCenter`, `IntakeQueue`,
`work-desk-app.tsx` and the `tools/quotes` pages. The specialty screens follow the same
convention deliberately rather than deviating in one module. All warnings introduced by
this work — unused imports, a missing `useMemo` dependency, a redundant eslint-disable —
were fixed; the specialty files now report zero warnings.

## 17. Production build result

`npm run build` — **passes.** All routes compiled; no new dynamic/static warnings.

Full unit suite: `npm test` — **3,186 passed, 129 files, 4 skipped** (the integration
suites self-skip without credentials).

Integration suite: `npm run test:integration` — the specialty file is **57/57 passing**.
Four pre-existing failures remain in
`src/features/time-attendance/server/__tests__/queue-status-bug-condition.integration.test.ts`,
in its `C8: every availability change is attributable` block. They are unrelated to this
work, there is no diff under `src/features/time-attendance`, and the file fails identically
when run alone. By its own name that suite documents an unfixed attendance bug condition.

---

## 18. Manual Supabase and deployment steps

**Migrations: none outstanding.** `v1.16.0` … `v1.16.7` are applied to project
`kfbgftkjvtynfdwgcgeb`, each with passing post-conditions.

**Storage: none.** The `specialty-quote-documents` bucket and its policies were created by
`v1.16.1`.

**Environment variables: none added.** The engine uses the existing browser Supabase
client and the RPCs; no service-role key and no new secret is required.

**Realtime:** `specialty_opportunities`, `specialty_carrier_markets` and
`specialty_activity` were added to the `supabase_realtime` publication by `v1.16.1`.

**After deploying the application:**

1. Sign in as Oscar, Jason or Brenda and confirm **Specialty Quotes** appears in the
   sidebar. It is granted by team membership, so it will not appear for anyone else.
2. Open **User Administration → Quoting Teams** and confirm both teams and both routes
   read as expected.
3. Submit one test Trucking intake and one test Homeowners intake through the existing
   Customer Service form and confirm each lands unclaimed on the right team.
4. Confirm the adopted card `SQ-92CCBE47` opens in Specialty Quotes and no longer appears
   on the Commercial Board, and that Commercial GL cards are untouched.

**If a line of business ever has no active routing**, `cs_intake_submit_specialty` refuses
the submission with a message naming the line rather than creating orphaned work. Fix it in
Quoting Teams, not in code.

---

## 19. Deferred Commercial-migration considerations

Not implemented, by instruction. What was architected for it:

- `commercial_gl` is accepted by every LOB check constraint on
  `specialty_workflow_templates`, `quoting_team_lob_routes` and
  `specialty_opportunities`, so a Commercial Team and a Commercial template need no schema
  change. `v1.16.0` asserts that it created **no** `commercial_gl` route, so nothing
  reroutes today.
- Carrier markets, activity, documents, notes, checklists, assignment and every report are
  already line-agnostic. A third line inherits all of it.
- The adoption pattern in `v1.16.6` generalises: it selects on `coverage_type`, and
  Commercial GL cards would be selected by the intake back-link
  (`cs_intake_submissions.source_commercial_quote_id`) or by the activity-log marker
  `details->>'source' = 'cs_intake'`, since `coverage_type = 'gl'` cannot distinguish an
  intake-created card from a hand-made one.

Open questions to settle before migrating Commercial, none of which this work forecloses:

- **Commission.** `commercial_quotes` carries `commission_status`,
  `commission_decision_by`, `commission_decision_at`, `commission_denial_reason`,
  `commission_notes`, and two board columns plus a whole review screen and report built on
  them. The specialty engine has no commission concept. That is the largest single gap.
- **Board columns as stages.** `commission_approved` and `commission_not_approved` are
  board columns, not quoting stages. They would need either two more stages or a separate
  post-close workflow.
- **Risk level.** `risk_level` is masked from non-managers by the commercial API. There is
  no equivalent field or masking in the specialty model.
- **Coverage type.** `commercial_quotes.coverage_type` distinguishes `gl`, `wc`, `umb`,
  `gl_wc`, `gl_wc_umb`, `bop`. One specialty line cannot express that; it wants either a
  per-opportunity coverage field or one template per combination.
- **`is_mirrored` and archive.** Both are commercial-board concepts with no specialty
  counterpart.
- **Volume.** Commercial has ~81 intake-created cards against the two this migration
  adopted. The adoption loop is per-card and its post-conditions are per-card, so it would
  work, but it should be dry-run against a copy first rather than run straight at
  production.

Recommended sequence if it goes ahead: add commission and coverage-type support to the
specialty model first, run the adoption against a database copy, compare the commercial
reports against the specialty reports for one full reporting period, and only then switch
the `commercial_gl` route and stop the legacy path.

---

## Also worth knowing

**`supabase/schema.sql` is a v0.7.2 baseline and is not current.** It contains no
reference to `cs_intake_submissions` at all. Everything in this work was written against
the live schema, dumped via `scripts/query-sql.mjs`, and against the incremental
migrations — not against that file.

**Nothing here touches a queue rotation.** Specialty work is claimed from a shared team
pool and has no relationship to the WhatsApp, RingCentral or Additional Workload
rotations. `cs_intake_submit_specialty` joins the non-consuming family alongside
`cs_intake_manager_assign`. Two migration post-conditions and one unit test assert that no
specialty function reads or writes `rotation_state`, `turn_events` or
`next_eligible_profile`, so a future change cannot quietly give one a rotation side
effect.
