# Design Document: Carrier Email Submission from Specialty Quotes

## Overview

This design adds the ability to send a carrier submission by email from the Specialty Quote
workspace, from Oscar's own Microsoft 365 mailbox, with the generated carrier application and
supporting documents attached, and a permanent, immutable record of what was sent.

It is deliberately additive. Four of the requirements are already partly implemented in the
codebase; this design extends what is there rather than building alongside it.

### Key design decisions

1. **Reuse `specialty_documents` as Quote Documents.** The table already is what the specification
   asked for: per-opportunity, optionally carrier-tagged, ten categories including
   `generated_application`, unique on `(storage_bucket, storage_path)`. A second table would split
   the quote's files across two stores and duplicate the storage-path access contract.

2. **Extend `market_directory`, do not create a carrier-email table.** `submission_email` already
   exists there. Four additive columns complete it. RLS on that table already restricts writes to
   `specialty_is_manager()`, so "managers can change the address without a deploy" needs no new
   policy.

3. **Reuse the existing carrier status vocabulary.** All seven states the specification named
   already exist. The vocabulary is stated in four places that must not drift — a CHECK constraint,
   an inline list inside `specialty_update_carrier_market`, `CARRIER_STATUS_ORDER`, and the detail
   RPC's ordering CASE — and a parity test enforces two of them. Adding values would mean touching
   all four for no behavioural gain.

4. **Send through the Microsoft Graph draft path, not `/me/sendMail`.** `POST /me/sendMail` returns
   `202 Accepted` with an empty body and **no message identifier**, which cannot satisfy
   Requirement 10.4. Creating a draft returns both `id` and `internetMessageId`; the latter is the
   RFC-822 `Message-ID`, is assigned at draft creation, and survives the move into Sent Items. One
   code path also covers both attachment size regimes.

5. **Reserve before sending.** The row is inserted with status `sending` and a unique idempotency
   key *before* the provider is contacted, following the pattern already proven in
   `cancellation_communications`. The unique constraint is the lock. This is the opposite of the
   renewal-SMS route, which sends first and logs after and can therefore lose a record.

6. **Encrypt tokens in the application, not in Postgres.** AES-256-GCM via `node:crypto`, key in a
   server-only environment variable. A database dump alone is inert. This matches the codebase's
   existing convention that secrets live in the environment and never in the database, and it means
   service-role access does not imply mailbox access.

7. **Sender eligibility is data.** A `profiles.can_send_carrier_submissions` boolean, set for Oscar
   by a data migration keyed on `username = 'oscar'` — the same mechanism used to promote him to
   super admin in v1.3.2. Enabling a second sender is an UPDATE.

8. **Snapshot attachments at send time.** The submission-documents rows carry the file name and
   storage path as sent, not only a foreign key, so renaming or deleting a Quote Document later
   cannot rewrite history.

---

## Architecture

### System context

```
┌───────────────────────────── Next.js (Vercel) ──────────────────────────────┐
│                                                                              │
│  Specialty Quote workspace                                                   │
│    CarriersPanel ─▶ SubmissionsPanel ─▶ PrepareSubmissionDialog              │
│                            │                                                 │
│                            ▼  (client → server, never provider)              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ /api/specialty/carrier-submissions                                   │    │
│  │   POST  send        GET  list                                        │    │
│  │ /api/email-connections                                               │    │
│  │   GET  status       DELETE  disconnect                               │    │
│  │ /api/email-connections/microsoft/start                               │    │
│  │ /api/email-connections/microsoft/callback                            │    │
│  └───────────┬──────────────────────────────────┬──────────────────────┘    │
│              │                                  │                            │
│   src/lib/crypto/secret-box.ts        src/lib/microsoft-mail.ts             │
│   (AES-256-GCM seal/open)             (the ONLY module that names           │
│              │                         login.microsoftonline.com,           │
│              │                         graph.microsoft.com, or MS_*)        │
└──────────────┼──────────────────────────────────┼───────────────────────────┘
               │                                  │
               ▼                                  ▼
        Supabase Postgres                  Microsoft Entra ID
        + Storage                          + Microsoft Graph
```

### Send sequence

```
Sender clicks Send
      │
      ├─ 1. Authorize: caller is a Sender, may edit this Opportunity
      ├─ 2. Load Email_Connection; refresh access token if near expiry
      │        └─ refresh fails ─▶ status = needs_reconnect, 409, nothing sent
      ├─ 3. Validate recipients, resolve selected Quote_Documents
      ├─ 4. RESERVE  insert carrier_submissions (status='sending', idempotency_key)
      │        └─ 23505 ─▶ return the existing submission, send nothing
      ├─ 5. Download attachment bytes from Storage (service-role, server-side)
      ├─ 6. POST /me/messages           → draft id + internetMessageId
      ├─ 7. attachments  ≤3 MB total: inline on create
      │                  >3 MB:        createUploadSession per file, 320 KB-multiple chunks
      ├─ 8. POST /me/messages/{id}/send → 202
      │        └─ any failure ─▶ status='failed' + reason, carrier status untouched
      ├─ 9. RECORD   status='sent', provider_message_id, sent_at
      ├─ 10. snapshot carrier_submission_documents rows
      ├─ 11. advance carrier status via specialty_update_carrier_market (if not_started/preparing)
      └─ 12. log specialty_activity 'carrier_submission_emailed'
```

Steps 4 and 9 bracket the provider call. A crash between them leaves a `sending` row, which is
visible, blocks a duplicate, and is reconcilable — the safe failure direction.

---

## Database design

New migration: `supabase/migrations/v1.21.0-carrier-email-submission.sql`. Additive throughout; no
existing column changes type or meaning.

### 1. `public.user_email_connections`

```sql
create table if not exists public.user_email_connections (
  id                            uuid primary key default gen_random_uuid(),
  profile_id                    uuid not null references public.profiles(id) on delete cascade,
  provider                      text not null default 'microsoft'
                                  check (provider in ('microsoft')),
  email_address                 text not null
                                  check (char_length(btrim(email_address)) > 0),
  provider_account_id           text not null,
  provider_tenant_id            text,
  encrypted_access_credentials  text not null,
  token_expires_at              timestamptz,
  scopes                        text[] not null default '{}',
  status                        text not null default 'connected'
                                  check (status in ('connected','needs_reconnect','disconnected')),
  last_error                    text,
  connected_at                  timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  constraint user_email_connections_one_active_per_provider
    unique (profile_id, provider)
);

create trigger user_email_connections_touch
  before update on public.user_email_connections
  for each row execute function public.touch_updated_at();
```

`encrypted_access_credentials` holds a **versioned envelope**, not a bare ciphertext:

```
v1.<base64url iv (12B)>.<base64url auth tag (16B)>.<base64url ciphertext>
```

The plaintext is a JSON object `{ access_token, refresh_token, obtained_at }`. One column, one
envelope, a version prefix so a future key rotation can decrypt v1 and write v2.

**Column-level revoke** — RLS is row-level, so the credential column needs its own grant control:

```sql
revoke select (encrypted_access_credentials) on public.user_email_connections from authenticated, anon;
```

A browser session with a valid JWT can read its own connection row's address and status, and cannot
read the ciphertext at all. Server code reads it with the service-role client.

RLS:

| Policy | Command | Predicate |
|---|---|---|
| `user_email_connections_v1210_select` | SELECT | `profile_id = auth.uid() or public.specialty_is_manager()` |
| `user_email_connections_v1210_delete` | DELETE | `profile_id = auth.uid()` |

No INSERT or UPDATE policy: connections are written only by the OAuth callback through the
service-role client. This mirrors `specialty_activity`, which is append-only for the same reason.

### 2. `public.carrier_submissions`

```sql
create table if not exists public.carrier_submissions (
  id                    uuid primary key default gen_random_uuid(),
  opportunity_id        uuid not null references public.specialty_opportunities(id) on delete cascade,
  carrier_market_id     uuid not null references public.specialty_carrier_markets(id) on delete cascade,
  market_id             uuid references public.market_directory(id),
  submitted_by          uuid not null references public.profiles(id),
  email_connection_id   uuid references public.user_email_connections(id) on delete set null,

  from_email            text not null,
  to_email              text[] not null check (array_length(to_email, 1) >= 1),
  cc_email              text[] not null default '{}',

  subject               text not null check (char_length(btrim(subject)) > 0),
  body                  text not null,

  submission_kind       text not null default 'initial'
                          check (submission_kind in ('initial','additional_documents','revised')),
  status                text not null default 'sending'
                          check (status in ('sending','sent','failed')),
  failure_reason        text,
  failure_retryable     boolean,
  provider              text not null default 'microsoft',
  provider_message_id   text,
  provider_draft_id     text,

  idempotency_key       text not null,
  attachment_count      integer not null default 0,
  attachment_bytes      bigint not null default 0,

  sent_at               timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint carrier_submissions_idempotency
    unique (carrier_market_id, idempotency_key),
  constraint carrier_submissions_sent_needs_provider_id
    check (status <> 'sent' or provider_message_id is not null),
  constraint carrier_submissions_sent_needs_timestamp
    check (status <> 'sent' or sent_at is not null),
  constraint carrier_submissions_failed_needs_reason
    check (status <> 'failed' or failure_reason is not null)
);

create index carrier_submissions_market_idx
  on public.carrier_submissions (carrier_market_id, created_at desc);
create index carrier_submissions_opportunity_idx
  on public.carrier_submissions (opportunity_id, created_at desc);
```

The three CHECK constraints are the database-level statement of Requirement 10.3: a row cannot claim
`sent` without a provider identifier and a timestamp. That guarantee does not depend on application
code being correct.

`market_id` is denormalised deliberately — a carrier can be relinked or a Market renamed, and the
historical record should say which configuration was used.

RLS:

| Policy | Command | Predicate |
|---|---|---|
| `carrier_submissions_v1210_select` | SELECT | `public.specialty_can_view_opportunity(opportunity_id)` |

INSERT and UPDATE are service-role only — the send route owns the whole lifecycle. There is no
DELETE policy: submissions are permanent (Requirement 7.4).

### 3. `public.carrier_submission_documents`

```sql
create table if not exists public.carrier_submission_documents (
  id                 uuid primary key default gen_random_uuid(),
  submission_id      uuid not null references public.carrier_submissions(id) on delete cascade,
  quote_document_id  uuid references public.specialty_documents(id) on delete set null,
  file_name          text not null,
  storage_bucket     text not null,
  storage_path       text not null,
  mime_type          text not null,
  file_size          bigint,
  created_at         timestamptz not null default now()
);

create index carrier_submission_documents_submission_idx
  on public.carrier_submission_documents (submission_id);
```

`quote_document_id` is `on delete set null` while `file_name`, `storage_bucket` and `storage_path`
are `not null` copies. That is the snapshot: deleting the Quote Document nulls the pointer and
leaves the record of what was sent intact. The UI reads the snapshot and, when the pointer is null
or the object is gone, says so rather than showing a broken link.

SELECT policy mirrors the parent through `carrier_submissions`.

### 4. `market_directory` extension

```sql
alter table public.market_directory
  add column if not exists submission_cc              text[] not null default '{}',
  add column if not exists submission_subject_template text,
  add column if not exists submission_body_template    text,
  add column if not exists email_submission_enabled    boolean not null default false;
```

No RLS change: the existing `market_directory_v1170_update` policy already restricts writes to
`specialty_is_manager()`. No whitelist change: `updateMarket` in
`src/features/specialty/market-directory/api.ts` passes its patch straight through, so the only gate
is the TypeScript `MarketDirectoryPatch` interface plus that policy.

Seeding: the migration sets `email_submission_enabled = true` and a `submission_email` for All Star
Underwriters, Commonwealth Underwriters and Eastern Underwriting Managers **only if an address is
supplied**; otherwise it leaves the flag false, so no carrier becomes submittable by accident.

### 5. `profiles` extension

```sql
alter table public.profiles
  add column if not exists can_send_carrier_submissions boolean not null default false;

update public.profiles
   set can_send_carrier_submissions = true
 where username = 'oscar';
```

Plus a SQL helper mirroring the existing `specialty_is_manager()` shape:

```sql
create or replace function public.can_send_carrier_submissions()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select p.can_send_carrier_submissions and p.is_active
      from public.profiles p where p.id = auth.uid()
  ), false);
$$;
```

### 6. Activity event type

`specialty_activity.event_type` is constrained by the named constraint
`specialty_activity_event_type_check`. Following the established drop-and-readd pattern from
v1.17.0, add `carrier_submission_emailed` and `carrier_submission_failed` to the full list.

Note `specialty_log` is revoked from `authenticated` and derives its actor from `auth.uid()`, so a
service-role call would record a NULL actor. The send route therefore inserts into
`specialty_activity` directly with an explicit `actor_profile_id`, which is exactly what
`generate-application/route.ts` already does.

---

## Encryption

`src/lib/crypto/secret-box.ts`, roughly 60 lines, no dependencies beyond `node:crypto`.

```ts
export function seal(plaintext: string): string    // → "v1.<iv>.<tag>.<ciphertext>"
export function open(envelope: string): string     // throws on tag mismatch or bad version
export function isEncryptionConfigured(): boolean
```

- Algorithm `aes-256-gcm`, 12-byte random IV per seal, 16-byte auth tag, all base64url.
- Key from `EMAIL_TOKEN_ENCRYPTION_KEY`, a base64 32-byte value; generated with
  `openssl rand -base64 32`. Read at call time, trimmed, blank treated as absent — the same
  `readEnv()` discipline as `src/lib/email.ts`.
- `open()` verifies the auth tag, so a tampered ciphertext throws rather than returning garbage.
- The module never logs, and never includes key or plaintext in a thrown message.

**Operational consequence, stated plainly:** if `EMAIL_TOKEN_ENCRYPTION_KEY` is lost or rotated
without re-encrypting, every stored connection becomes undecryptable and every Sender must
reconnect. That is a deliberate trade — it is the property that makes a database dump useless — and
it is why the envelope carries a version prefix. Historical submissions are unaffected.

---

## Microsoft 365 integration

`src/lib/microsoft-mail.ts` is the **only** module permitted to name
`login.microsoftonline.com`, `graph.microsoft.com`, or any `MS_*` environment variable, mirroring
the isolation the repo already enforces for Resend and RingCentral.

### Entra ID application

A single-tenant app registration is required, with:

- Redirect URI `https://<host>/api/email-connections/microsoft/callback` (plus a localhost entry)
- Delegated permissions `Mail.Send`, `User.Read`, `offline_access` — **no mail-read scope**
- A client secret

Environment variables: `MS_OAUTH_CLIENT_ID`, `MS_OAUTH_CLIENT_SECRET`, `MS_OAUTH_TENANT_ID`,
`MS_OAUTH_REDIRECT_URI`.

### Authorization code + PKCE

`GET /api/email-connections/microsoft/start` generates a 32-byte random `state` and a PKCE
verifier, stores both in a signed, `httpOnly`, `SameSite=Lax`, 10-minute cookie, and redirects to
the tenant authorize endpoint with `code_challenge_method=S256`.

`GET /api/email-connections/microsoft/callback` compares the returned `state` against the cookie in
constant time, clears the cookie immediately so it cannot be replayed, exchanges the code for
tokens, calls `GET /me` for the authoritative mailbox address and account id, seals the token pair,
and upserts the connection row through the service-role client.

A cookie rather than a table is chosen because the state is single-use, expires in minutes, and
never needs to be queried; a table would be state to garbage-collect for no gain.

### Token refresh

`getSendableToken(connection)` returns a valid access token or a typed failure. It refreshes when
the token is within 120 seconds of expiry, persists the new sealed envelope and expiry, and on
`invalid_grant` sets `status = 'needs_reconnect'` with a human-readable `last_error` and returns a
failure the route surfaces as 409. It never throws with a token in the message.

### Sending

```ts
export async function sendMailAsUser(input: {
  accessToken: string;
  subject: string; body: string;
  to: string[]; cc: string[];
  attachments: { fileName: string; mimeType: string; bytes: Buffer }[];
}): Promise<MailSendResult>
```

`MailSendResult` follows the shape already used by `sendEmail` and `sendSms` —
`{ success, messageId, draftId, failureReason, retryable }` — and **never throws**.

1. `POST /me/messages` with subject, HTML body, recipients, and — when the base64-inflated total is
   under 3 MB — inline `#microsoft.graph.fileAttachment` entries. Response yields `id` and
   `internetMessageId`.
2. Otherwise, per attachment, `POST /me/messages/{id}/attachments/createUploadSession` and `PUT`
   chunks in multiples of 320 KB.
3. `POST /me/messages/{id}/send`, expecting `202`.
4. Return `internetMessageId` as `messageId`. It is the RFC-822 `Message-ID`, stable across the move
   into Sent Items, and the value a carrier's reply will reference — a more durable identifier than
   the mutable Graph item id, which is also stored as `provider_draft_id` for support purposes.

Because the draft is created in Oscar's mailbox and sent from it, the message lands in his Sent
Items and carrier replies thread to him — which is the point of connecting a real mailbox rather
than relaying through Resend.

Retryable is derived the same way `src/lib/email.ts` does it: HTTP 429 and 5xx are retryable,
timeouts are retryable, 4xx otherwise is not. Phase 1 does not auto-retry; it reports.

---

## Template rendering and the coverage block

`src/features/carrier-submissions/templates.ts`, pure and React-free so an API route can import it.

```ts
export function renderTemplate(template: string, vars: Record<string, string>): string
export function buildCoverageLines(coverages: TruckingCoverages): CoverageLine[]
export function buildCoverageSummary(lines: CoverageLine[]): string
export function findUnresolvedPlaceholders(text: string): string[]
```

Placeholders are `{{name}}`; an unknown name is left verbatim so the composer's warning
(Requirement 5.10) can find it rather than silently emitting an empty string.

The coverage block is derived from `TruckingCoverages` on the trucking data packet — the same
structure the PDF engine already fills from — and includes a line only when the coverage was
actually requested:

| Line | Source | Emitted when |
|---|---|---|
| Auto Liability | `auto_liability_limit` | limit present |
| UM/UIM | `um_uim_limit` | limit present |
| Physical Damage | `physical_damage_requested`, `physical_damage_deductible`, `pd_comprehensive`, `pd_collision` | requested |
| Motor Truck Cargo | `cargo_limit`, `cargo_deductible` | limit present |
| Trailer Interchange | `trailer_interchange_limit`, `trailer_interchange_deductible` | requested or limit present |
| General Liability | `general_liability_limit` | requested or limit present |
| Other | `additional_coverages_other` | non-blank |

`buildCoverageSummary` produces the short subject-line form — `AL / PD / Cargo` — from the same
lines, so subject and body cannot disagree.

Default templates, used when a Market has none:

```
Subject: {{company_name}} - {{coverage_summary}} Submission

Hello,

Please find attached the submission for {{company_name}}.

Requested Coverages:

{{coverage_lines}}

Please review and let us know if any additional information is required.

Thank you,
{{sender_name}}
New Hope Insurance Agency
```

---

## API surface

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/email-connections` | GET | session | This user's connection status |
| `/api/email-connections` | DELETE | session, own connection | Disconnect |
| `/api/email-connections/microsoft/start` | GET | session + Sender | Begin OAuth |
| `/api/email-connections/microsoft/callback` | GET | session + state cookie | Complete OAuth |
| `/api/specialty/carrier-submissions` | GET | session, can view Opportunity | History for a Carrier_Market |
| `/api/specialty/carrier-submissions` | POST | session + Sender + can edit Opportunity | Send |

All declare `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`. The send route sets
`maxDuration = 120` to allow for large-attachment upload sessions.

The codebase has four competing auth patterns. This feature adopts the **Time & Attendance
`api-actor` contract** — a discriminated `ActorResolution` and the typed
`unconfigured/unauthenticated/unauthorised/invalid/conflict/failed` response shapes — because it is
the most disciplined of the four and gives the composer machine-readable codes to react to
(`needs_reconnect` → 409 with a link, rather than a generic 403). A thin
`src/features/carrier-submissions/server/actor.ts` extends it with the Sender check.

Routes stay thin; logic lives in `src/features/carrier-submissions/`, matching the convention the
cancellations provider-isolation test enforces for that module.

---

## User interface

Placement is the existing full-page workspace (`src/features/specialty/workspace/`). Two additions:

**`SubmissionsPanel.tsx`** — a new panel alongside Overview, Carriers, Application, Documents and
Activity. Lists every Carrier_Market with carrier name, status badge (reusing `carrierStatusLabel`
and `carrierStatusTone` so labels match everywhere), last sent date, sender, submission count, and a
Prepare Submission button. Expanding a carrier reveals its Submission history: kind, date, sender,
attachment count, and a View action showing From, To, CC, subject, body and attachments exactly as
sent.

**`PrepareSubmissionDialog.tsx`** — From (read-only, from the connection, with a connect prompt when
absent); editable To and CC chips; editable subject; editable body seeded from the template; the
attachment list with the matching Generated Application pre-checked; an upload control that writes a
permanent Quote Document; a running attachment total; and a Send button disabled while any blocking
condition holds, each with a stated reason.

Within `CarriersPanel`, a Prepare Submission entry is added to the per-carrier workspace's
extensions stack, which already receives `market_directory_id`, `line_of_business`,
`opportunityId`, `carrierMarketId` and `profileId`, and already follows the
`if (!marketDirectoryId) return null` convention this feature needs for Requirement 2.8.

The dialog generates its idempotency key once on open (`crypto.randomUUID()`) and reuses it for
every send attempt from that dialog instance. A double-click therefore cannot produce two emails,
and neither can a client-side retry.

---

## Fix carried by this work

`src/app/api/specialty/generate-application/route.ts` step 11 inserts the mirror
`specialty_documents` row **without checking the returned error**, unlike steps 9 and 10 either side
of it. When that insert fails, the PDF exists in storage and in
`market_generated_applications` but never appears in the Documents panel — and, once this feature
ships, cannot be attached to a submission. Requirement 3.3 makes the check mandatory.

The same route also leaves an orphan when a document is deleted: `specialty_documents` has a DELETE
policy and `market_generated_applications` does not, so deleting the document row and its storage
object leaves a generated-application row pointing at a missing object. This design does not fix
that; it is recorded in `tasks.md` as a follow-up so it is not lost.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `EMAIL_TOKEN_ENCRYPTION_KEY` | base64 32 bytes; AES-256-GCM key for token envelopes |
| `MS_OAUTH_CLIENT_ID` | Entra app registration client id |
| `MS_OAUTH_CLIENT_SECRET` | Entra app registration secret |
| `MS_OAUTH_TENANT_ID` | Tenant id for nhpfs.com (single-tenant) |
| `MS_OAUTH_REDIRECT_URI` | Must match the app registration exactly |

All server-only. None prefixed `NEXT_PUBLIC_`. All to be added to `.env.example` with comments, and
to `LIVE-DEPLOYMENT-GUIDE.md` — the same documentation gap that currently leaves `CRON_SECRET`
undocumented and both schedulers silently inert.

---

## Testing strategy

**Unit, no network, no database:**

- `secret-box` — round-trip; tampered ciphertext throws; tampered tag throws; wrong version throws;
  two seals of the same plaintext differ (IV is random).
- `templates` — placeholder substitution; unknown placeholder left verbatim and reported;
  coverage lines emitted only when requested; limit-and-deductible formatting; subject summary
  agrees with body lines.
- `microsoft-mail` — with `fetch` injected: inline path under 3 MB; upload-session path over it;
  429 and 503 retryable, 400 not; timeout retryable; `internetMessageId` returned as `messageId`;
  **a token never appears in any returned failure reason**.
- Authorization — a non-Sender is refused; a Sender cannot use another profile's connection;
  `needs_reconnect` yields 409 and no provider call.
- Idempotency — a repeated key returns the original submission and performs no second send;
  concurrent sends produce one email (property test, mirroring
  `scheduler-idempotency.property.test.ts`).

**Provider isolation** — a new test mirroring
`src/features/cancellations/__tests__/provider-isolation.test.ts`, asserting that
`login.microsoftonline.com`, `graph.microsoft.com` and the `MS_OAUTH_*` names appear nowhere in
`src/`, `scripts/` or the repo root outside `src/lib/microsoft-mail.ts` and `.env.example`.

**Migration parity** — extend the existing specialty parity test to assert the new CHECK
vocabularies match their TypeScript unions, and **repair the oracle first** so it composes
constraints altered by later migrations. That repair is already an open item; this feature depends
on it, because `carrier_submissions.status` will be introduced in v1.21.0 while the oracle reads
only v1.16.x.

**Integration, live project, self-skipping** — following the existing convention that reads
`SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` and skips when absent: RLS denies a foreign
profile's connection row; `authenticated` cannot select `encrypted_access_credentials`; the three
`carrier_submissions` CHECK constraints reject a `sent` row lacking a provider id, a timestamp, or a
`failed` row lacking a reason.

**Manual** — one real submission to a controlled address, verifying it arrives from
`olanda@nhpfs.com`, appears in Sent Items, carries the right attachments, and produces one record.

---

## Risks

| Risk | Mitigation |
|---|---|
| Entra admin consent may be required for `Mail.Send` depending on tenant policy | Confirm before Phase B; a tenant admin can grant once |
| Losing `EMAIL_TOKEN_ENCRYPTION_KEY` invalidates all connections | Documented; versioned envelope allows rotation; submissions unaffected |
| Graph throttling (429) on bursts | Single-user, low volume; retryable is surfaced, not swallowed |
| Attachment totals above the inline limit | Upload-session path implemented from the start, not deferred |
| Carriers with `market_directory_id = null` cannot be submitted to | Stated in the UI with the remedy (Requirement 2.8), not a silent disappearance |
| Committed migrations do not reconstruct the live database (`quote_number` has no committed `alter table`) | Out of scope here, but v1.21.0 must not assume a clean rebuild; recorded in `tasks.md` |
| A crash between reserve and send leaves a `sending` row | Visible, blocks duplicates, reconcilable — the safe direction; a reconciliation view is a Phase 2 item |
