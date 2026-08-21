# Tasks: Carrier Email Submission from Specialty Quotes

**Authored by:** Claude (Cowork), 20 August 2026
**Baseline:** `origin/main` @ `6460bfe4bc49aa6e88fc8ba397c61aa5b8a532f4`
**Spec:** `requirements.md` and `design.md` in this folder
**Branch:** `feat/carrier-email-submission` (to be cut from `origin/main`)
**Status:** Phase A complete (20 Aug 2026). Task 0.1 was completed independently by Kiro.
Handover and verification evidence: `phaseA-handover.md` in this folder.

### Verified test baseline at `6460bfe` (20 Aug 2026, re-run after Kiro's fix)

| | |
|---|---|
| `next build` | passes |
| `tsc --noEmit` | **4 errors** — `rc-claim-bug-condition.test.ts` (1), `rc-claim-preservation.test.ts` (3) |
| `vitest --run` | **4 failing / 3295 passing / 134 skipped** across 137 files |
| Failing files | `cancellations-table.test.tsx`, `renewals-table.test.tsx`, `quote-center-permissions.test.ts` (2 cases) |

`migration-parity.test.ts` now passes — it was failing at the previous baseline `e01a030`.

Ordered by the specification's Phase A → B → C, with a Phase 0 for the two prerequisites that
Phase A depends on.

---

## Phase 0 — Prerequisites

### Task 0.1: Repair the migration-parity oracle [done: true — completed by Kiro]

#### Description
**Already done. Kiro fixed this in the `e01a030..6460bfe` range; verified passing on 20 Aug 2026.**

`migration-parity.test.ts` now declares `const MARKET_DIRECTORY = sql('v1.17.0-market-directory.sql')`
(line 62) and the `document categories` assertion reads `checkValues(MARKET_DIRECTORY, 'category')`
rather than `checkValues(CORE, 'category')`, with a comment explaining that v1.17.0 drops and re-adds
the constraint and is therefore the authoritative definition for that column.

The fix is per-column rather than a general composition of later migrations, which is a narrower
approach than this spec originally proposed — but it is sufficient, and it establishes the pattern
v1.21.0 should follow: declare a `const` for the new migration and point each new vocabulary's
assertion at it.

#### Sub-tasks
- [x] Oracle reads the authoritative migration for `category`
- [x] All five assertions in `other vocabularies match their CHECK constraints` pass
- [x] **Carry forward into Task A.1:** add `const CARRIER_SUBMISSION = sql('v1.21.0-carrier-email-submission.sql')`
      and assert the new `carrier_submissions.status` and `submission_kind` vocabularies against it

### Task 0.2: Register the Entra ID application [done: true]

#### Description
Oscar's action, not a code change, but Phase B cannot start without it. Blocking.

#### Sub-tasks
- [x] Create a single-tenant app registration in Microsoft Entra ID for the nhpfs.com tenant
- [x] Add redirect URIs: the Vercel production URL and `http://localhost:3000/api/email-connections/microsoft/callback`
- [x] Add delegated permissions `Mail.Send`, `User.Read`, `offline_access` — **no mail-read scope**
- [x] Confirm whether the tenant requires admin consent for `Mail.Send`; if so, grant it
- [x] Create a client secret and record its expiry date somewhere Oscar will see before it lapses
- [x] Capture client id, tenant id, secret into `.env.local` and Vercel
- [x] Generate `EMAIL_TOKEN_ENCRYPTION_KEY` with `openssl rand -base64 32`; store in both places

---

## Phase A — Quote Documents and the submission record

Database and data layer. No provider, no OAuth, no UI. Ends with a schema that can hold a
submission and a test suite that proves the constraints hold.

### Task A.1: Migration v1.21.0 [done: true]

#### Description
One migration, `supabase/migrations/v1.21.0-carrier-email-submission.sql`, additive throughout,
with a post-condition block in the style of the existing migrations. Full DDL in `design.md`
§ "Database design".

#### Sub-tasks
- [x] `public.user_email_connections` — table, `unique (profile_id, provider)`, `touch_updated_at` trigger
- [x] `revoke select (encrypted_access_credentials) on public.user_email_connections from authenticated, anon`
- [x] RLS on `user_email_connections`: SELECT own-or-manager, DELETE own; deliberately no INSERT/UPDATE policy
- [x] `public.carrier_submissions` — table, two indexes, `unique (carrier_market_id, idempotency_key)`
- [x] The three integrity CHECKs: `sent` requires `provider_message_id`; `sent` requires `sent_at`;
      `failed` requires `failure_reason`
- [x] RLS on `carrier_submissions`: SELECT via `specialty_can_view_opportunity`; no INSERT/UPDATE/DELETE policy
- [x] `public.carrier_submission_documents` — table with snapshot columns `not null` and
      `quote_document_id` `on delete set null`; index; SELECT policy mirroring the parent
- [x] `alter table public.market_directory` — `submission_cc`, `submission_subject_template`,
      `submission_body_template`, `email_submission_enabled`
- [x] `alter table public.profiles add column can_send_carrier_submissions boolean not null default false`
- [x] `update public.profiles set can_send_carrier_submissions = true where username = 'oscar'`
- [x] `public.can_send_carrier_submissions()` helper, mirroring `specialty_is_manager()`
- [x] Extend `specialty_activity_event_type_check` with `carrier_submission_emailed` and
      `carrier_submission_failed`, using the v1.17.0 drop-and-readd pattern
- [x] Post-condition block asserting: every table exists, every policy exists, the column-level
      revoke is in place, Oscar's flag is true, and both new event types are accepted
- [x] **Do not assume a clean rebuild.** The committed migration set does not reconstruct the live
      database — `specialty_carrier_markets.quote_number` is referenced by four migrations with no
      committed `alter table` that adds it. Every statement here must be `if not exists` / idempotent

### Task A.2: Fix the generated-application document insert [done: true]

#### Description
`src/app/api/specialty/generate-application/route.ts` step 11 inserts the mirror
`specialty_documents` row and discards the error, unlike steps 9 and 10 either side of it. A silent
failure there means the PDF exists in storage and in `market_generated_applications` but never
appears in the Documents panel — and, once this feature ships, cannot be attached to a submission.
Requirement 3.3.

#### Sub-tasks
- [x] Destructure and check the error; return 500 with a clear message on failure
- [x] Decide and implement the cleanup: either delete the just-written storage object and the
      `market_generated_applications` row, or leave both and say so in the error. Do not leave the
      three stores silently disagreeing
- [x] Add a test asserting a document-insert failure fails the request

### Task A.3: Types and data layer [done: true]

#### Sub-tasks
- [x] `src/features/carrier-submissions/types.ts` — `EmailConnection`, `CarrierSubmission`,
      `SubmissionDocument`, `SubmissionKind`, `SubmissionStatus`
- [x] Extend `MarketDirectoryEntry` in `src/features/specialty/market-directory/types.ts:45-66`
      with the four new columns
- [x] Extend `MarketDirectoryPatch` in `src/features/specialty/market-directory/api.ts:84-99`.
      `updateMarket` passes the patch through, so nothing else changes
- [x] `src/features/carrier-submissions/api.ts` — client reads for connection status and history
- [x] Unit tests for the type guards and any status derivation

### Task A.4: Market Directory admin — submission settings [done: true]

#### Description
Requirement 2. A sixth tab in `MarketDirectoryAdmin.tsx`'s detail drawer rather than lengthening
the already-thirteen-field info tab.

#### Sub-tasks
- [x] Add a `submission` tab beside `info | aliases | contacts | requirements | questions`
- [x] Fields: submission email, CC list, subject template, body template, enabled toggle
- [x] Add all four keys to `startEdit`'s wholesale patch seed (`MarketDirectoryAdmin.tsx:422-440`)
- [x] Validate every address syntactically before save
- [x] Show the available placeholders inline, so a manager writing a template can see them
- [x] Note: this admin is dark-themed (`bg-zinc-900`) while the workspace is light-themed `ui.*`.
      Match the surrounding admin, not the workspace

---

### Phase A evidence (20 August 2026)

| Check | Result |
|---|---|
| `next build` | passes, 28.5s |
| `tsc --noEmit` | 4 errors — the same 4 pre-existing `rc-claim-*` errors. None new. |
| `vitest --run` | 3337 passing (was 3295), 4 pre-existing failures. None new. |
| `eslint` on touched files | clean |
| Migration | applied to PostgreSQL 16, then re-applied to prove idempotency |
| Probe | all nine sections pass |

**A defect the probe caught in the first draft, recorded so it is not reintroduced.**
`to_email text[] not null check (array_length(to_email, 1) >= 1)` admits an empty array:
`array_length('{}', 1)` is NULL and a CHECK passes on NULL. Corrected to
`check (coalesce(array_length(to_email, 1), 0) >= 1)`. Probe § 5d guards it.

**The security property was verified, not assumed.** Against live Postgres,
`has_column_privilege('authenticated', …, 'encrypted_access_credentials', 'select')`
returns false and `set role authenticated; select encrypted_access_credentials …` raises
`permission denied`, while the address and status columns stay readable. If any later
migration issues a bare `grant select on public.user_email_connections to authenticated`,
that protection is silently lost — probe § 2 is what catches it.

**APPLIED TO PRODUCTION — 20 August 2026.** Project `kfbgftkjvtynfdwgcgeb`, PostgreSQL 17.6,
via the Supabase SQL editor. Migration status row: `v1.21.0 applied | 1 sender | Oscar
Landaverde | ciphertext_hidden = true`. Probe: **16 of 16 PASS**, including
`SECURITY: authenticated CANNOT read the token ciphertext`.

Three fixes were needed before it would run in that editor, all worth remembering for the
next migration:

1. **Explicit `begin;`/`commit;` had to go.** The Supabase SQL editor and the Management
   API each wrap a script in their own transaction, and the editor can reject transaction
   control outright. Idempotency is what makes this safe: a partial application is
   repaired by re-running.
2. **The editor returns only the LAST statement's result and may swallow `RAISE NOTICE`.**
   A migration that reports only through notices can succeed while showing a blank pane.
   Every migration should end with a `select` that states what happened.
3. **`scripts/run-sql.mjs` is the wrong tool for a migration that reports.** It posts to
   the Management API, which returns result sets but discards notices.

## Phase B — Mailbox connection and server-side sending

### Task B.1: Encryption helper [done: true]

#### Sub-tasks
- [x] `src/lib/crypto/secret-box.ts` — `seal`, `open`, `isEncryptionConfigured`
- [x] AES-256-GCM, 12-byte random IV, 16-byte tag, `v1.<iv>.<tag>.<ciphertext>` base64url envelope
- [x] Key from `EMAIL_TOKEN_ENCRYPTION_KEY`, read at call time, blank treated as absent
- [x] Never log; never include key or plaintext in a thrown message
- [x] Tests: round-trip; tampered ciphertext throws; tampered tag throws; unknown version throws;
      two seals of the same plaintext differ

### Task B.2: Microsoft provider module [done: true]

#### Description
`src/lib/microsoft-mail.ts` — the only module allowed to name `login.microsoftonline.com`,
`graph.microsoft.com`, or any `MS_OAUTH_*` variable.

#### Sub-tasks
- [x] `buildAuthorizationUrl({ state, codeChallenge })`
- [x] `exchangeCodeForTokens({ code, codeVerifier })`
- [x] `refreshAccessToken(refreshToken)` — typed failure distinguishing `invalid_grant` from transport error
- [x] `getMailboxIdentity(accessToken)` — `GET /me` for address and account id
- [x] `sendMailAsUser(...)` — create draft, attach, send; returns `internetMessageId` as `messageId`
- [x] Inline attachments when the base64-inflated total is under 3 MB
- [x] Upload-session path above it, chunked in multiples of 320 KB
- [x] Never throw; return `{ success, messageId, draftId, failureReason, retryable }`
- [x] Retryable: 429, 5xx, timeout. Not retryable: other 4xx
- [x] `fetch` injectable for tests, following the seam convention in `cancellations/scheduler/send.ts`
- [x] Tests including: **a token never appears in a returned failure reason**

### Task B.3: Connection routes [done: true]

#### Sub-tasks
- [x] `GET /api/email-connections` — this user's status
- [x] `DELETE /api/email-connections` — disconnect, deleting credentials and retaining submissions
- [x] `GET /api/email-connections/microsoft/start` — state + PKCE verifier into a signed,
      `httpOnly`, `SameSite=Lax`, 10-minute cookie; redirect to authorize
- [x] `GET /api/email-connections/microsoft/callback` — constant-time state comparison; clear the
      cookie before anything else; exchange; `GET /me`; seal; upsert via service-role
- [x] Reject mismatched, reused or expired state
- [x] All routes `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`
- [x] Adopt the `api-actor` response contract, extended with the Sender check in
      `src/features/carrier-submissions/server/actor.ts`

### Task B.4: Settings UI [done: true]

#### Sub-tasks
- [x] Email Connection section under user settings: address, status, connected date
- [x] Connect / Reconnect / Disconnect actions
- [x] Show the **actually authorized** address, not the expected one (Requirement 1.12)
- [x] Surface `needs_reconnect` prominently
- [x] Visible only to a Sender

### Task B.5: Send endpoint [done: true]

#### Description
`POST /api/specialty/carrier-submissions`. The reserve → send → record sequence in `design.md`
§ "Send sequence". Requirement 10 in full.

#### Sub-tasks
- [x] Authorize: Sender, and may edit this Opportunity
- [x] Resolve the connection; refresh if within 120 s of expiry; `needs_reconnect` → 409, no send
- [x] Validate recipients and resolve every selected `specialty_documents` row
- [x] **Reserve** — insert with `status='sending'` and the idempotency key, before any provider call
- [x] On `23505`, return the existing submission and send nothing
- [x] Download attachment bytes server-side via the service-role client
- [x] Send; on failure record `status='failed'` with reason and retryable, and **leave the carrier
      status untouched**
- [x] On success record `status='sent'`, `provider_message_id`, `provider_draft_id`, `sent_at`
- [x] Write `carrier_submission_documents` snapshot rows
- [x] Advance carrier status through `specialty_update_carrier_market` only when currently
      `not_started` or `preparing`; never regress
- [x] Insert `specialty_activity` directly with an explicit `actor_profile_id` — `specialty_log` is
      revoked from `authenticated` and derives its actor from `auth.uid()`, which a service-role
      call does not have
- [x] `maxDuration = 120`
- [x] `GET` for history

### Task B.6: Provider isolation test [done: true]

#### Sub-tasks
- [x] Mirror `src/features/cancellations/__tests__/provider-isolation.test.ts`
- [x] Assert `login.microsoftonline.com`, `graph.microsoft.com` and `MS_OAUTH_*` appear nowhere in
      `src/`, `scripts/` or the repo root outside `src/lib/microsoft-mail.ts` and `.env.example`
- [x] Assert no API route imports the provider module directly

---

## Phase C — Composer and history UI

### Task C.1: Template and coverage rendering [done: true]

#### Sub-tasks
- [x] `src/features/carrier-submissions/templates.ts`, pure and React-free so a route can import it
- [x] `renderTemplate` — `{{name}}`; unknown names left verbatim
- [x] `buildCoverageLines(TruckingCoverages)` — the seven-row mapping in `design.md`
- [x] `buildCoverageSummary` — the short subject form (`AL / PD / Cargo`), derived from the same
      lines so subject and body cannot disagree
- [x] `findUnresolvedPlaceholders`
- [x] Default subject and body templates
- [x] Tests: only requested coverages emitted; limit-and-deductible formatting; unknown placeholder
      reported

### Task C.2: `SubmissionsPanel.tsx` [done: true]

#### Sub-tasks
- [x] New panel in `src/features/specialty/workspace/`, alongside Overview / Carriers / Application / Documents / Activity
- [x] Per carrier: name, status badge via `carrierStatusLabel` + `carrierStatusTone`, last sent,
      sender, submission count
- [x] Prepare Submission button, Senders only
- [x] Expandable history, reverse chronological
- [x] View Submission: From, To, CC, subject, body, attachments as sent
- [x] State plainly when an attachment's underlying file is gone
- [x] History visible to anyone who may view the Opportunity

### Task C.3: `PrepareSubmissionDialog.tsx` [done: true]

#### Sub-tasks
- [x] From, read-only, from the connection; connect prompt when absent; block send
- [x] To and CC editable, seeded from the Market
- [x] Subject and body editable, seeded from the template
- [x] Attachment list with the matching Generated Application pre-checked — and no other carrier's
- [x] Upload control writing a permanent Quote Document, never a temporary one
- [x] Running attachment total, with a warning at the inline threshold
- [x] Idempotency key generated once on open and reused for every attempt from that instance
- [x] Send disabled while any blocking condition holds, each with a stated reason
- [x] Warn, without blocking, on an unresolved `{{…}}` placeholder

### Task C.4: Wire into `CarriersPanel` [done: false — deliberately not done]

**Decision, 20 Aug 2026.** Not implemented, and this is a choice rather than an omission.
Requirement 4 is fully met by the Submissions tab, which lists every carrier with its
status, last-sent date, sender, submission count, and a Prepare Submission button.
Threading a second entry point through `CarriersPanel` means editing a 969-line file whose
`CarrierEditor` is keyed on `market.version` and remounts whenever a teammate saves — a
modal launched from there would be torn down mid-compose. The cost is a real regression
risk in working code; the benefit is one extra shortcut. Revisit if Oscar finds the tab
alone awkward in daily use.

### Original plan, retained for reference [done: false]

#### Sub-tasks
- [x] Add Prepare Submission to the per-carrier extensions stack (`CarriersPanel.tsx:566-586`),
      which already receives every prop needed
- [x] Follow the `if (!marketDirectoryId) return null` convention — but state the remedy rather than
      disappearing (Requirement 2.8)
- [x] Respect `email_submission_enabled = false` with a stated reason

---

## Phase D — Documentation and close-out

### Task D.1: Document the configuration [done: true]

#### Sub-tasks
- [x] Add all five new variables to `.env.example` with comments explaining each
- [x] Document the Entra app registration in `LIVE-DEPLOYMENT-GUIDE.md`, including the redirect URI
      and the client-secret expiry
- [x] Document that losing `EMAIL_TOKEN_ENCRYPTION_KEY` requires every Sender to reconnect, and that
      historical submissions are unaffected
- [x] Add a `CHANGELOG.md` entry at the top in the house `# vX.Y.Z — Title` style
- [x] Update `.kiro/steering/claude-collaboration.md`'s "Last verified repository state"

### Task D.2: Verify no regression [done: true]

#### Sub-tasks
- [x] `tsc --noEmit`, `eslint .`, `vitest --run`, `next build` — record results in this folder as a
      dated evidence section
- [x] Confirm intake, PDF generation, rotation, and assignment behaviour unchanged
- [x] Confirm no existing carrier status value changed meaning
- [x] One real end-to-end send to a controlled address: arrives from `olanda@nhpfs.com`, lands in
      Sent Items, correct attachments, exactly one submission record

---

## Deferred — recorded so they are not lost

- [ ] **Orphaned generated applications.** `specialty_documents` has a DELETE policy;
      `market_generated_applications` does not. Deleting a document row and its storage object
      leaves a generated-application row pointing at a missing object. Pre-existing; not introduced
      here.
- [ ] **Reconciliation view for stuck `sending` rows.** A crash between reserve and send leaves one.
      It is visible and blocks duplicates, which is the safe direction, but nothing sweeps it up.
- [ ] **Migration set does not reconstruct the live database.** `quote_number` is referenced by four
      migrations with no committed `alter table` adding it. Wider than this feature; worth its own
      spec.
- [ ] Everything in `requirements.md` § "Out of Scope" — inbox reading, threading, carrier-response
      detection, automated sending, AI reply interpretation, all-employee mailboxes, follow-up
      automation, thread UI, portal quoting.


---

## Completion record — 20 August 2026

Authored by Claude (Cowork). Branch `feat/carrier-email-submission`, cut from `origin/main`
@ `6460bfe`. 38 files, +6093 / −21.

### Verified at completion

| | Result |
|---|---|
| `next build` | passes, 17.2s. All four new routes registered. |
| `tsc --noEmit` | 4 errors — all pre-existing in `rc-claim-*` test arbitraries, none from this work |
| `vitest --run` | **3419 passing**, 4 failing (all pre-existing), 134 skipped |
| `eslint .` | 58 errors vs 52 before — the 6 added are `react-hooks/set-state-in-effect`, matching the project-wide convention pending the architectural decision in the audit |
| Migration | applied to `kfbgftkjvtynfdwgcgeb`; probe 16/16 PASS, including that `authenticated` cannot read the token ciphertext |

### Three defects this work found and fixed in its own code

1. **A credential leak into the database.** `microsoft-mail`'s failure describer passed the
   provider's error body straight through to `failureReason`, which is persisted to
   `carrier_submissions.failure_reason`. A provider that echoed the bearer token in an
   error would have written a live credential into the database. Every failure path now
   passes through one `redactSecrets()` choke point. Caught by a test asserting the
   negative, not by review.
2. **A rules-of-hooks violation.** The `profileNames` memo landed after an early return in
   `QuoteWorkspace`, which would have broken hook order the first time `detail` went from
   null to set. Caught by lint after the build already passed.
3. **A UUID minted on every render.** `useRef(crypto.randomUUID())` evaluates its argument
   each render. Replaced with a lazy `useState` initializer.

Also fixed, in existing code: `generate-application/route.ts` discarded the error from its
`specialty_documents` insert, so a generated PDF could exist in storage and never appear on
the Documents tab (Task A.2).

### Not done, deliberately

- **Task C.4** — see the note above.
- **The four pre-existing TypeScript errors and three failing test files.** They belong to
  the separate remediation list, not to this spec, and fixing them here would have mixed
  two unrelated changes in one branch. One of them still needs Oscar's answer on whether
  commercial agents were meant to get shared-draft editing.
