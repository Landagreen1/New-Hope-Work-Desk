# Phase A handover — carrier email submission

**Authored by:** Claude (Cowork), 20 August 2026
**Branch:** `feat/carrier-email-submission`, cut from `origin/main` @ `6460bfe`
**Spec:** `.kiro/specs/carrier-email-submission` — Tasks A.1 through A.4

---

## What is in it

| File | | |
|---|---|---|
| `supabase/migrations/v1.21.0-carrier-email-submission.sql` | new | 401 lines |
| `supabase/verification/v1.21.0-carrier-submission-probe.sql` | new | 166 lines |
| `src/features/carrier-submissions/types.ts` | new | |
| `src/features/carrier-submissions/templates.ts` | new | |
| `src/features/carrier-submissions/recipients.ts` | new | |
| `src/features/carrier-submissions/__tests__/templates.test.ts` | new | 23 tests |
| `src/features/carrier-submissions/__tests__/recipients.test.ts` | new | 19 tests |
| `src/app/api/specialty/generate-application/route.ts` | modified | Task A.2 |
| `src/features/specialty/market-directory/MarketDirectoryAdmin.tsx` | modified | Submission tab |
| `src/features/specialty/market-directory/types.ts` | modified | 4 columns |
| `src/features/specialty/market-directory/api.ts` | modified | 4 patch keys |

11 files, +1530 / −20.

## Verification

| Check | Result |
|---|---|
| `next build` | ✅ compiled in 28.5s |
| `tsc --noEmit` | ✅ 4 errors — the same 4 as before, in `rc-claim-*`. None new. |
| `vitest --run` | ✅ 3337 passing, up from 3295. Same 4 pre-existing failures. None new. |
| `eslint` on touched files | ✅ clean |
| Migration | ✅ applied to a real PostgreSQL 16 instance, then re-applied to prove idempotency |
| Verification probe | ✅ all nine sections pass |

The migration was not merely written — it was run. I installed PostgreSQL, built a stub
schema, applied v1.21.0, and probed it.

## The bug that found

The probe caught a real defect in my own first draft, which is the reason it exists:

```sql
to_email text[] not null check (array_length(to_email, 1) >= 1)
```

`array_length('{}', 1)` returns **NULL**, not 0, and a CHECK constraint **passes on
NULL**. That constraint admitted a submission with no recipient. Fixed to:

```sql
check (coalesce(array_length(to_email, 1), 0) >= 1)
```

§ 5d of the probe exists specifically to stop that regressing.

## Proven, not just asserted

The security property this feature rests on is that a browser session cannot read the
stored mailbox tokens. Confirmed against live Postgres:

```
select has_column_privilege('authenticated','public.user_email_connections',
                            'encrypted_access_credentials','select');
 → f

set role authenticated; select encrypted_access_credentials from public.user_email_connections;
 → ERROR: permission denied for table user_email_connections
```

The address and status columns remain readable, so the settings screen still works.

**This is why RLS alone was not enough.** RLS is row-level. A table-wide `SELECT` grant
is *not* overridden by a column-level `REVOKE` — so the migration revokes SELECT
wholesale and re-grants twelve columns by name. If a future migration ever issues a bare
`grant select on public.user_email_connections to authenticated`, the ciphertext becomes
readable and § 2 of the probe turns true. That is the one line to watch.

---

## How to get this onto your machine

**Option A — the patch (keeps it on its own branch, matching the working agreement):**

```bash
cd "C:\Users\landa\Documents\New Hope Work Desk\New-Hope-Work-Desk"
git checkout -b feat/carrier-email-submission origin/main
git apply --3way phase-a-carrier-email-submission.patch
git status
```

**Option B — the loose files.** I have written all eleven directly into your working
tree, so Kiro and VS Code will show them as ordinary changes against `main`. If you take
this route, move them onto a branch before committing:

```bash
git checkout -b feat/carrier-email-submission
git add -A && git commit -m "feat(specialty): carrier email submission — Phase A"
```

I have not pushed anything. I have no write access to the repository, by design.

---

## Before Phase B — apply the migration

The migration has **not** been applied to your live Supabase project. I have no
credentials for it and would not use them unasked.

```bash
# In the Supabase SQL editor, or via your usual apply script:
supabase/migrations/v1.21.0-carrier-email-submission.sql
# then, to confirm:
supabase/verification/v1.21.0-carrier-submission-probe.sql
```

The probe prints PASS lines and raises on any failure. Its § 5 writes rows and rolls
them back; nothing it does persists.

Expect this notice on a successful run:

```
NOTICE: v1.21.0: 1 profile(s) may send carrier submissions
NOTICE: v1.21.0 carrier email submission: schema installed and verified.
```

If it says **0 profiles**, the `where username = 'oscar'` update matched nothing and your
username differs. Tell me and I will adjust it.

---

## One decision left over from the audit

`quote-center-permissions.test.ts` still fails, and it is not mine to resolve. Commit
`37b5441` granted Quote Center access to commercial agents, and that grant also makes
`editSharedDraft('commercial')` return `true`. If shared-draft **editing** was not
intended for commercial agents, the fix belongs in the permission function rather than in
the test. Updating the assertion would approve the behaviour, and that approval is yours.

---

## Next: Phase B

Encryption helper, the Microsoft provider module, the OAuth routes, the settings screen,
and the send endpoint. All of it now unblocked, since your Entra registration is done and
the consent screen appeared.
