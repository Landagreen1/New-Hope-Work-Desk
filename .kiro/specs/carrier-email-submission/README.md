# Spec: Carrier Email Submission from Specialty Quotes

**Authored by:** Claude (Cowork), 20 August 2026, from Oscar's written specification
**Baseline:** `origin/main` @ `6460bfe`
**Status:** specification only. **No code has been written.**

This folder follows the conventions in `.kiro/steering/claude-collaboration.md`. There is
deliberately no `.config.kiro` and no `tasks.meta.json` — those carry Kiro's `specId` and session
state, and Claude does not write them. Kiro may adopt this folder and generate its own.

| File | Contents |
|---|---|
| `requirements.md` | 14 numbered requirements in EARS form, a glossary, and an explicit Out of Scope list |
| `design.md` | Architecture, full DDL, RLS, encryption, the Microsoft 365 integration, templates, API surface, UI placement, testing, risks |
| `tasks.md` | Phase 0 → A → B → C → D, in the repo's `[done: false]` + `- [ ]` format |

## Decisions Oscar made before this was written

| | |
|---|---|
| Mail provider | Microsoft 365 — OAuth 2.0 + PKCE against Entra ID, sending via Microsoft Graph |
| Token storage | App-layer AES-256-GCM, key in a server-only env var, never in the database |
| Carrier statuses | Reuse the existing vocabulary; add none |

## What the audit changed about the original spec

Four of the specification's requirements were already partly built. The spec was rewritten against
what exists rather than describing a greenfield system.

1. **Do not create a `quote_documents` table.** `public.specialty_documents` already is one —
   per-opportunity, optionally carrier-tagged, ten categories including `generated_application`.
2. **Generated PDFs are already saved as documents.** The requirement is already met — except the
   insert discards its error, so it can fail silently. That fix is Task A.2.
3. **`market_directory.submission_email` already exists.** Four additive columns complete the
   carrier configuration; no new table.
4. **All seven proposed statuses already exist** under different labels. `not_started` is already
   displayed as "Not Submitted", `preparing` as "Ready". No new vocabulary.

## Two things worth reading before implementation starts

**Phase 0 blocks Phase A.** The migration-parity oracle is already failing and reads only
`v1.16.x`; v1.21.0 adds two more constrained vocabularies. Fix the oracle first or every new value
looks like drift.

**`/me/sendMail` cannot satisfy Requirement 10.4.** It returns `202` with an empty body and no
message identifier. The design uses the draft path — create, attach, send — which yields
`internetMessageId`, handles both attachment size regimes in one path, and puts the message in
Oscar's Sent Items so carrier replies thread to him.
