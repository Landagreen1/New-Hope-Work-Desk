# Requirements Document

## Introduction

This specification defines carrier email submission from Specialty Quotes: the ability to send a
trucking (or other specialty) quote submission directly from the Work Desk to a carrier, from
Oscar's real mailbox, with the generated carrier application and supporting documents attached, and
a permanent record of exactly what was sent.

The platform is Next.js 16 (App Router, Turbopack) with React 19, Supabase (Postgres, RLS-first
authorization, Storage), TypeScript strict, and Tailwind 4.

**Phase 1 scope is one sender.** Only Oscar connects a mailbox and sends. The schema and the
permission model are built so additional senders are a data change and a permission flag, not a
migration.

**Mail provider: Microsoft 365.** Authorization is OAuth 2.0 authorization-code with PKCE against
Microsoft Entra ID; sending is Microsoft Graph. Oscar's mailbox is `olanda@nhpfs.com`.

**This is not an email client.** Reading the inbox, threading, carrier-reply detection, and
automated follow-up are explicitly out of scope — see "Out of Scope" below.

### What already exists (audited at `origin/main` `6460bfe`)

Four of this specification's requirements are already partly built. This document states the
*remaining* work against what is there, rather than describing a greenfield system.

| Spec concept | Existing implementation | Consequence |
|---|---|---|
| Quote Documents | `public.specialty_documents` — per-opportunity, nullable `carrier_market_id`, ten categories, `unique (storage_bucket, storage_path)`, RLS with no UPDATE policy | **Do not create a `quote_documents` table.** Reuse this one. |
| Generated PDF saved as a document | `src/app/api/specialty/generate-application/route.ts` already inserts a `specialty_documents` row with `category = 'generated_application'` | Requirement already met **except** the insert discards its error — see Requirement 3. |
| Carrier submission email address | `market_directory.submission_email text` (v1.17.0) | Extend this table; do not add a parallel carrier config. |
| Carrier submission status | `specialty_carrier_markets.status` already carries all seven states the spec asked for, under different names | **No new status vocabulary.** See Requirement 9. |

## Glossary

- **Opportunity** — a specialty quote. Row in `public.specialty_opportunities`. The spec's "quote".
- **Carrier_Market** — one carrier being worked on one opportunity. Row in
  `public.specialty_carrier_markets`. The unit a submission is sent for.
- **Market** — the reusable master carrier configuration. Row in `public.market_directory`. Reached
  from a Carrier_Market through `specialty_carriers.market_directory_id`, which is **nullable**.
- **Quote_Document** — a file attached to an Opportunity, optionally tagged to a Carrier_Market.
  Row in `public.specialty_documents`.
- **Generated_Application** — a carrier PDF produced by the application engine. Row in
  `public.market_generated_applications`, plus a mirror `specialty_documents` row.
- **Email_Connection** — a Work Desk user's authorized mailbox. Row in
  `public.user_email_connections`.
- **Submission** — one email actually sent to a carrier for a Carrier_Market. Row in
  `public.carrier_submissions`. A Carrier_Market may have many.
- **Submission_Snapshot** — the frozen record of what a Submission contained: recipients, subject,
  body, and the attachment list as sent.
- **Sender** — a profile permitted to send submissions. Phase 1: Oscar only.

---

## Requirements

### Requirement 1: Mailbox connection

**User Story:** As Oscar, I want to connect my real work mailbox once and have the Work Desk send
on my behalf, so carriers receive submissions from me and their replies come back to me.

#### Acceptance Criteria

1. THE system SHALL provide a settings screen showing connection state: not connected, connected
   (with the mailbox address and the date connected), or needs reconnection.
2. THE system SHALL offer Connect, Reconnect, and Disconnect actions.
3. WHEN a user begins Connect, THE system SHALL redirect to Microsoft Entra ID using OAuth 2.0
   authorization-code flow with PKCE and a cryptographically random, single-use `state` value.
4. THE system SHALL request only the scopes it needs: `Mail.Send`, `User.Read`, and
   `offline_access`. THE system SHALL NOT request any mail-read scope.
5. WHEN the OAuth callback returns, THE system SHALL verify the `state` value against the one it
   issued and SHALL reject a mismatched, reused, or expired `state`.
6. THE system SHALL store the refresh token and access token encrypted at rest, and SHALL store the
   mailbox address, the provider account identifier, and the token expiry in plaintext.
7. THE system SHALL NOT store an email password under any circumstance.
8. WHEN an access token is expired or within a refresh margin, THE system SHALL refresh it
   server-side using the stored refresh token before sending.
9. IF a refresh fails because consent was revoked or the token is invalid, THEN THE system SHALL set
   the connection status to `needs_reconnect` and SHALL surface that state in the settings screen
   and at the point of sending.
10. WHEN a user disconnects, THE system SHALL delete the stored credentials and SHALL retain every
    historical Submission record.
11. THE system SHALL bind a connection to exactly one profile, and SHALL allow at most one active
    connection per profile per provider.
12. IF the connected mailbox address differs from the address the user expected, THEN THE settings
    screen SHALL display the actual authorized address, because that is the address carriers will
    see.

### Requirement 2: Carrier submission configuration

**User Story:** As a manager, I want to maintain each carrier's submission address and standard
message from the Market Directory, so changing where a submission goes never requires a deploy.

#### Acceptance Criteria

1. THE system SHALL extend `public.market_directory` with a submission CC list, a subject template,
   a body template, and an enabled flag. THE existing `submission_email` column SHALL be reused as
   the primary recipient.
2. THE system SHALL allow a manager or super admin to edit all submission fields from the Market
   Directory administration screen, without a code change.
3. THE system SHALL NOT allow a non-manager to edit submission configuration.
4. THE subject and body templates SHALL support the placeholders `{{company_name}}`,
   `{{coverage_summary}}`, `{{carrier_name}}`, `{{sender_name}}`, and `{{coverage_lines}}`.
5. WHEN a template is absent for a Market, THE system SHALL fall back to a built-in default
   template so every carrier can be submitted to.
6. THE system SHALL validate that `submission_email` and every CC entry is a syntactically valid
   address before saving.
7. THE system SHALL treat `email_submission_enabled = false` as "this carrier is not submitted to
   by email", and SHALL hide or disable the Prepare Submission action for it with a stated reason.
8. IF a Carrier_Market's carrier has no linked Market (`market_directory_id is null`), THEN THE
   system SHALL state that the carrier must be linked to a Market Directory entry before it can be
   submitted to, rather than failing silently.

### Requirement 3: Quote Documents

**User Story:** As Oscar, I want every file for a quote — generated applications and uploads alike —
in one place, so preparing a submission is choosing from a list rather than hunting for files.

#### Acceptance Criteria

1. THE system SHALL use the existing `public.specialty_documents` table as the Quote Documents
   store. THE system SHALL NOT introduce a second document table.
2. THE system SHALL continue to scope documents to an Opportunity, with an optional
   `carrier_market_id` tag.
3. WHEN the application engine generates a carrier PDF, THE system SHALL record it as a
   Quote_Document with category `generated_application` **and SHALL fail the generation request if
   that record cannot be written**, so a generated PDF is never invisible to the submission
   composer.
4. THE system SHALL NOT require an agent to download and re-upload a generated application in order
   to attach it.
5. WHEN a document is uploaded from the submission composer, THE system SHALL store it as a
   permanent Quote_Document. THE system SHALL NOT create submission-only temporary uploads.
6. THE system SHALL preserve the existing storage path contract: the first path segment is the
   Opportunity's UUID. Access remains gated by `specialty_can_access_document_object`.

### Requirement 4: Carrier Submissions section

**User Story:** As Oscar, I want to see at a glance which carriers I have submitted to on this
quote, and start a submission from there.

#### Acceptance Criteria

1. THE Specialty Quote workspace SHALL present a Carrier Submissions view listing every
   Carrier_Market on the Opportunity.
2. FOR each carrier THE view SHALL show the carrier name, submission status, the date of the most
   recent Submission, who sent it, and the number of Submissions to date.
3. THE view SHALL offer a Prepare Submission action per carrier.
4. WHEN a carrier has never been submitted to, THE view SHALL show "Not Submitted" and SHALL still
   offer Prepare Submission.
5. THE Prepare Submission action SHALL be visible only to a Sender. Non-senders SHALL see the
   submission history if their existing quote permissions allow it.

### Requirement 5: Submission composer

**User Story:** As Oscar, I want the Work Desk to draft the email for me and let me correct it
before it goes.

#### Acceptance Criteria

1. WHEN a Sender opens Prepare Submission, THE system SHALL populate From from the Sender's
   connected mailbox address.
2. IF the Sender has no connected mailbox, or the connection needs reconnection, THEN THE system
   SHALL NOT allow sending and SHALL link to the connection settings.
3. THE system SHALL populate To from the Market's `submission_email`, and CC from its CC list.
4. THE Sender SHALL be able to edit To and CC before sending.
5. THE system SHALL generate the subject from the Market's subject template, defaulting to
   `{{company_name}} - {{coverage_summary}} Submission`.
6. THE system SHALL generate an editable body from the Market's body template, including a
   requested-coverages block.
7. THE coverage block SHALL list only coverages actually requested on the linked intake. THE system
   SHALL derive them from the trucking data packet's coverage fields, covering Auto Liability,
   UM/UIM, Physical Damage, Motor Truck Cargo, Trailer Interchange, General Liability, and any
   free-text additional coverages.
8. WHERE a coverage has a limit and a deductible, THE line SHALL state both.
9. THE Sender SHALL be able to edit the subject and the body freely before sending.
10. THE composer SHALL warn, without blocking, when the body still contains an unresolved `{{…}}`
    placeholder.

### Requirement 6: Attachments

**User Story:** As Oscar, I want the right carrier application pre-selected and the rest of the
quote's documents one click away.

#### Acceptance Criteria

1. THE composer SHALL list the Opportunity's Quote_Documents with checkboxes.
2. THE system SHALL pre-select the most recent Generated_Application whose `carrier_market_id`
   matches the carrier being submitted to.
3. THE system SHALL NOT pre-select a Generated_Application belonging to a different carrier.
4. THE Sender SHALL be able to select and deselect any listed document.
5. THE Sender SHALL be able to upload an additional document from the composer, and that upload
   SHALL become a permanent Quote_Document (Requirement 3.5).
6. THE system SHALL display each attachment's file name and size, and SHALL show a running total.
7. IF the total attachment size exceeds the provider's inline limit, THEN THE system SHALL still
   send, using a large-attachment upload path, or SHALL state clearly that the submission is too
   large and which file is responsible.
8. THE system SHALL refuse to send with zero attachments only if the Market's configuration
   requires an application; otherwise a body-only submission SHALL be permitted.

### Requirement 7: Submission record

**User Story:** As Oscar, I want to be able to prove months later exactly what I sent a carrier.

#### Acceptance Criteria

1. WHEN a send succeeds, THE system SHALL create exactly one `carrier_submissions` row.
2. THE row SHALL record the Opportunity, the Carrier_Market, the sender profile, the Email
   Connection used, the From address, the To and CC addresses, the subject, the body, the status,
   the provider message identifier, and the sent timestamp.
3. THE system SHALL create one `carrier_submission_documents` row per attachment, capturing the
   Quote_Document reference **and a snapshot of the file name and storage path as sent**.
4. THE historical record SHALL remain truthful if the underlying Quote_Document is later renamed,
   re-categorised, or deleted.
5. THE system SHALL NOT allow a Submission row to be updated after it reaches a terminal status,
   other than by the recording path itself.
6. THE system SHALL record a failed send as a failed Submission, and SHALL NOT present it as sent.

### Requirement 8: Submission history

**User Story:** As Oscar, I want to see the whole conversation of what I have sent this carrier, not
a single "submitted" tick.

#### Acceptance Criteria

1. THE system SHALL NOT represent submission state as a single boolean on the carrier.
2. THE system SHALL support many Submissions per Carrier_Market.
3. THE history SHALL list every Submission in reverse chronological order with its sent timestamp,
   sender, and attachment count.
4. THE Sender SHALL be able to open a Submission and see the From, To, CC, subject, body, and the
   attachment list exactly as sent.
5. THE system SHALL allow opening an attachment as it was sent, and SHALL state plainly when the
   underlying file no longer exists.
6. THE history SHALL offer Prepare Another Submission.
7. A user who may view the Opportunity SHALL be able to view its Submission history.

### Requirement 9: Carrier submission status

**User Story:** As Oscar, I want the carrier's status to update when I submit, without learning a
second vocabulary.

#### Acceptance Criteria

1. THE system SHALL reuse the existing `specialty_carrier_markets.status` vocabulary. THE system
   SHALL NOT add new status values.
2. THE mapping SHALL be: Not Submitted → `not_started`; Ready → `preparing`; Submitted →
   `submitted`; Waiting on carrier → `waiting`; Needs information → `more_info_needed`; Quoted →
   `quote_received`; Declined → `declined`.
3. WHEN a first Submission succeeds and the carrier's status is `not_started` or `preparing`, THE
   system SHALL advance it to `submitted` through the existing
   `specialty_update_carrier_market` RPC, so its `submitted_at` / `submitted_by` stamping, its
   activity logging, and its opportunity-stage advancement all continue to apply.
4. WHEN a subsequent Submission succeeds and the carrier has moved past `submitted`, THE system
   SHALL NOT regress the status.
5. THE system SHALL NOT build further workflow automation in Phase 1.

### Requirement 10: Sending behaviour

**User Story:** As Oscar, I want a send to either happen and be recorded, or not happen at all — and
never twice.

#### Acceptance Criteria

1. WHEN a Sender submits, THE system SHALL validate the Email_Connection, the recipient list, and
   every selected attachment before contacting the provider.
2. THE system SHALL perform the send server-side only.
3. THE system SHALL NOT mark a Submission as sent until the provider confirms acceptance.
4. THE system SHALL capture and store the provider message identifier.
5. THE system SHALL reserve the Submission before contacting the provider, using a caller-supplied
   idempotency key, so a double-click, a retry, or a duplicated request cannot produce two emails.
6. WHEN a request arrives bearing an idempotency key that already succeeded, THE system SHALL
   return the original Submission rather than sending again.
7. IF the provider rejects the send, THEN THE system SHALL record the failure with its reason and
   SHALL leave the carrier's status unchanged.
8. THE system SHALL distinguish retryable failures from permanent ones in what it stores and in what
   it tells the Sender.
9. THE system SHALL report success or failure to the Sender unambiguously, naming the recipient on
   success and the reason on failure.

### Requirement 11: Permissions

**User Story:** As the agency owner, I want only me sending from my mailbox, and I want that to be a
setting rather than something welded into the code.

#### Acceptance Criteria

1. THE system SHALL permit a Sender to connect a mailbox, prepare a submission, edit the recipients,
   subject, body and attachments, send, and view history.
2. THE system SHALL permit any user who may view the Opportunity to view its Submission history.
3. THE system SHALL NOT permit any user to send using another user's Email_Connection.
4. THE system SHALL NOT expose OAuth credentials, in any form, to any client.
5. THE system SHALL determine Sender status from data, not from a hardcoded identifier, so enabling
   a second sender is a configuration change.
6. THE system SHALL enforce every rule in this requirement in Postgres RLS as well as in the
   application, consistent with the codebase's RLS-first authorization.

### Requirement 12: Security

**User Story:** As the agency owner, I want a database leak not to hand someone my mailbox.

#### Acceptance Criteria

1. THE system SHALL encrypt refresh and access tokens at rest using AES-256-GCM, with the key held
   in a server-only environment variable and never stored in the database.
2. THE system SHALL store the authentication tag and initialisation vector alongside the ciphertext
   and SHALL verify the tag on decrypt.
3. THE system SHALL decrypt tokens only in server-side code, never in a client component or an
   RPC's return value.
4. THE system SHALL NOT log OAuth access tokens, refresh tokens, authorization codes, PKCE
   verifiers, or the encryption key.
5. THE system MAY log the Submission identifier, Opportunity identifier, carrier, sender address,
   recipient addresses, send status, and provider message identifier.
6. THE system SHALL revoke client SELECT on the encrypted credential columns, so a browser session
   cannot read ciphertext even with a valid JWT.
7. THE system SHALL confine provider credential names and hostnames to the owning module, in
   keeping with the existing provider-isolation test.

### Requirement 13: Placement

**User Story:** As an intake agent, I don't want carrier email controls appearing in the intake form.

#### Acceptance Criteria

1. THE feature SHALL live inside the full-page Specialty Quote workspace.
2. THE system SHALL NOT add carrier email functionality to the customer intake form.
3. THE workspace SHALL present Carrier Submissions alongside the existing Overview, Carriers,
   Application, Documents, and Activity areas.

### Requirement 14: Regression safety

**User Story:** As Oscar, I want this feature to be additive.

#### Acceptance Criteria

1. THE existing Specialty Quote behaviour, customer intake, carrier PDF generation, queue rotation,
   and assignment logic SHALL remain unchanged.
2. THE system SHALL NOT alter the meaning of any existing carrier status value.
3. THE system SHALL NOT change the existing document upload or download paths.
4. THE migration-parity test SHALL continue to pass.

---

## Out of Scope

Explicitly excluded from Phase 1. The schema is designed to accommodate them later; no code for
them is written now.

- Reading Oscar's inbox, or any mail-read OAuth scope
- Inbox synchronisation and message threading
- Automatic detection of carrier responses
- Sending without human review
- AI interpretation of carrier replies
- Connecting mailboxes for every employee
- Automatic follow-up emails
- A full email-thread user interface
- Carrier portal or API quoting

---

## Acceptance

The feature is complete when a Sender can connect a Microsoft 365 mailbox; a manager can maintain
carrier submission addresses and templates without a deploy; a generated carrier application appears
automatically among the quote's documents; the Sender can open a carrier, review a pre-filled
message and a pre-selected application, adjust recipients, text and attachments, and send; the email
arrives from the Sender's own mailbox; a failed send is never recorded as a success; a successful
send produces a permanent record of exactly what was sent; multiple submissions can exist for the
same carrier; and nothing that worked before behaves differently.
