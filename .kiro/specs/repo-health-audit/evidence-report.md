# Evidence Report: Repository Health Audit

**Authored by:** Claude (Cowork)
**Date:** 20 August 2026
**Commit audited:** `origin/main` @ `e01a030978df283818bf24834a2b534169c995e1`
**Method:** clean `git clone` of `origin/main` into an isolated Linux container, `npm ci`, then
`tsc --noEmit`, `eslint .`, `vitest --run`, and `next build` executed against that clean tree.
Oscar's local working copy at `C:\Users\landa\Documents\New Hope Work Desk\New-Hope-Work-Desk`
was compared file-by-file and matched `origin/main` exactly — the only differences were CRLF line
endings, so no uncommitted work was in flight at audit time.

This document records *observed* state. The remediation plan lives in `tasks.md` beside it.

---

## 1. Command results

| Command | Result |
|---|---|
| `next build` | **Passes.** All 66 API routes and all pages compile. |
| `tsc --noEmit` | **4 errors**, in 2 files, all test files |
| `vitest --run` | **5 failing / 3206 passing / 134 skipped** across 134 test files (69s) |
| `eslint .` | **52 errors, 143 warnings** |
| `npm audit` | 6 high, 2 moderate, 0 critical |

Because `next build` passes, none of the above blocks deployment. That is precisely why the four
TypeScript errors reached `main` unnoticed: nothing in the pipeline runs `tsc --noEmit`.

---

## 2. TypeScript errors (4)

Both files fail for one cause. Commit `e01a030` ("capture full underwriting data on intake and
fill it into carrier PDFs") added **58 fields** to `CsIntakeSubmission` — `primary_commodity`,
`cargo_description`, `broker_load_board`, `commodity_mix_known` and 54 more. The `fast-check`
arbitraries in these two suites still construct the pre-`e01a030` shape, so
`Arbitrary<{…}>` is no longer assignable to `Arbitrary<CsIntakeSubmission>`.

| File | Line | Error |
|---|---:|---|
| `src/features/cs-intake/__tests__/rc-claim-bug-condition.test.ts` | 131 | TS2322 |
| `src/features/cs-intake/__tests__/rc-claim-preservation.test.ts` | 216 | TS2322 |
| `src/features/cs-intake/__tests__/rc-claim-preservation.test.ts` | 273 | TS2322 |
| `src/features/cs-intake/__tests__/rc-claim-preservation.test.ts` | 330 | TS2322 |

Four call sites break on one schema addition, which is the signal that the arbitrary should be a
single shared factory rather than four inline literals.

---

## 3. Failing tests (5)

Every failure is a test that pinned behaviour which was then deliberately changed. **No failure
indicates a defect in shipped behaviour.** One raises a question that is Oscar's to answer.

### 3.1 `cancellations-table.test.tsx` — date format

```
- Expected  "Mar 4, 2026"
+ Received  "03/04/2026"
```

Commit `caf7883` ("standardize all date formatting to MM/DD/YYYY across the app") is the cause.
The rendered output is correct; the assertion is stale.

### 3.2 `renewals-table.test.tsx` — date format

Identical cause and identical shape to 3.1.

### 3.3 + 3.4 `quote-center-permissions.test.ts` — commercial role grant

```
AssertionError: commercial: expected true to be false
  at quote-center-permissions.test.ts:60  (viewQuoteCenter)
  at quote-center-permissions.test.ts:85  (editSharedDraft)
```

Commit `37b5441` ("grant Quote Center access to commercial agents") added `commercial` to the
permitted roles, but the suite still carries `commercial` inside its `UNRELATED_ROLES` fixture.

**Open question, recorded rather than resolved.** The grant affects *two* predicates. That
`viewQuoteCenter('commercial')` is now `true` is clearly the intent of the commit. That
`editSharedDraft('commercial')` is *also* now `true` may not be — the commit message says
"access", not "edit". If shared-draft editing was not intended for commercial agents, the
correction belongs in the permission function and not in the test.

### 3.5 `migration-parity.test.ts` — stale parity oracle

```
+ "generated_application"   (present in TypeScript, absent from the constraint the test reads)
```

The suite composes its `CORE` source from `v1.16.0` through `v1.16.6` only:

```ts
const CORE = sql('v1.16.1-specialty-opportunities.sql');
```

The `generated_application` document category was added later, by `ALTER` in
`supabase/migrations/v1.17.0-market-directory.sql` line 458. `DOCUMENT_CATEGORIES` in
`src/features/specialty/status.ts` is correct and the database is correct — the **oracle** is
stale.

This is the failure worth fixing properly rather than patching. The suite's stated purpose is to
catch TypeScript/SQL drift; as written it will emit a false failure every time a CHECK constraint
is legitimately widened by a later migration, which trains the team to ignore it.

---

## 4. Lint (52 errors, 143 warnings)

| Count | Severity | Rule |
|---:|---|---|
| 138 | warning | `@typescript-eslint/no-unused-vars` |
| **39** | **error** | `react-hooks/set-state-in-effect` |
| 5 | error | `react-hooks/static-components` |
| 3 | warning | `@next/next/no-img-element` |
| 2 | error | `react/no-unescaped-entities` |
| 2 | error | `react-hooks/purity` |
| 2 | error | `prefer-const` |
| 2 | warning | `react-hooks/exhaustive-deps` |
| 1 | error | `react-hooks/refs` |
| 1 | error | `react-hooks/immutability` |

Files carrying the most errors: `CommercialDatabase.tsx` (7), `components/work-desk-app.tsx` (6),
then a long tail of 1–2 each.

The 39 `set-state-in-effect` errors are the React 19 ruleset flagging one repeated pattern:

```tsx
useEffect(() => {
  void refresh();
}, [refresh]);
```

At 39 sites this is a project-wide convention, not an accident. It is a correctness and
performance smell (cascading renders), not a crash. **The decision is architectural** — migrate
the pattern deliberately, or downgrade the rule with a written reason. Fixing it file-by-file as
each is touched would leave the codebase in two idioms at once, which is worse than either.

The four `react-hooks/purity`, `refs`, and `immutability` errors are a different matter and should
each be read individually — those rules fire on genuinely incorrect code more often than not.

---

## 5. Dependency advisories

| Severity | Package | Advisory | Fix available |
|---|---|---|---|
| **high** | `next` 16.2.10 | Middleware/Proxy bypass in App Router with Turbopack; DoS via Server Actions | yes |
| high | `postcss` | Arbitrary file read via attacker-controlled `sourceMappingURL` | yes |
| high | `sharp` | Inherited libvips CVEs (transitive) | yes |
| high | `js-yaml` | Quadratic CPU on `!!omap` resolution | yes |
| high | `nanoid` | Infinite loop on non-positive size | yes |
| high | `brace-expansion` | DoS via unbounded expansion | yes |
| moderate | `exceljs` → `uuid` | Missing buffer bounds check in v3/v5/v6 | yes |

### Mitigating context for the Next.js advisory

This application uses `src/proxy.ts`, so the advisory applies on its face. It matters **less** here
than it would in most applications, because `updateSession` in `src/lib/supabase/proxy.ts` does not
gate access — it only refreshes the Supabase session cookie and returns:

```ts
await supabase.auth.getClaims();
return response;
```

Authorization is enforced per-route (`resolveActor` and equivalents across the 66 handlers) and in
Postgres RLS. A proxy bypass is therefore **not** an auth bypass in this codebase. That is a
genuinely more robust design than middleware-gated auth, and it is worth recording as a strength.
The patch should still be taken.

`postcss` is pinned to `8.5.10` through `overrides` in `package.json`; the advisory covers
`<=8.5.22`, so the pin does not clear it.

---

## 6. Absence of CI

There is **no `.github/` directory in this repository.** No workflow, no `CODEOWNERS`, no PR or
issue template, no Dependabot configuration, no `SECURITY.md`.

This is the direct cause of §2 and §3. A workflow running `tsc --noEmit` and `vitest --run` on push
takes well under two minutes and would have blocked all nine failures before they reached `main`.

---

## 7. Line-ending drift

The repository stores LF. Oscar's Windows checkout is CRLF. Every file compared between the two
differed on line endings alone. There is no `.gitattributes`.

This is already a known cost inside the codebase — `migration-parity.test.ts` carries a comment
explaining that it must normalise `\r\n` before matching, *because* a pattern spanning `;\n` does
not match `;\r\n` on a Windows checkout. A three-line `.gitattributes` removes the class of problem
rather than each instance of it.

---

## 8. Version drift across the repository

| Source | States |
|---|---|
| `README.md` | v0.9.4 |
| `package.json` | 0.9.4.1 |
| `CHANGELOG.md` (top entry) | v1.16.0 |
| `supabase/migrations/` (highest) | v1.17.0 |

`README.md` describes the feature set as of roughly twenty releases ago. It does not mention
Specialty Quotes, Time & Attendance, Cancellations, or the Sales Reporting Center.

---

## 9. Undocumented configuration: `CRON_SECRET`

`CRON_SECRET` is referenced in **six** places in source, including a carefully reasoned guard in
`src/features/cancellations/scheduler/authorize.ts` that documents the empty-secret attack and
deliberately avoids `startsWith` and `split(' ')`.

It appears in **zero** places in `.env.example`, `LIVE-DEPLOYMENT-GUIDE.md`, `SETUP-CHECKLIST.md`,
or any other document. There is also no `vercel.json`, so the cron schedule that would call these
endpoints is not defined anywhere in the repository.

The guard is fail-closed, so the consequence is not a vulnerability — it is that **both the
cancellation scheduler and the renewal SMS scheduler are silently inert** for anyone who deploys
by following the project's own setup documentation.

Related configuration observations, recorded for completeness:

- `.env.local` supplies 6 variables. The application additionally reads `RESEND_API_KEY`,
  `CANCELLATION_EMAIL_FROM`, `CANCELLATION_EMAIL_REPLY_TO`, `RC_CLIENT_ID`, `RC_CLIENT_SECRET`,
  `RC_JWT_TOKEN`, `RC_SMS_FROM_NUMBER`, and `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`. Locally, cancellation
  email, renewal SMS, both schedulers, and intake address autocomplete are therefore inert. If
  Vercel holds these, production is unaffected.
- Naming drift persists between `RC_*` (used by the product) and `RINGCENTRAL_*` (dead). The
  readiness bug this caused is fixed and documented in `scheduler/readiness.ts`, but the dead
  prefix still appears in test files and can re-enter.
- Every consumer resolves `SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY` **except**
  `scripts/assign-schedules.mjs`, which reads `SUPABASE_SERVICE_ROLE_KEY` alone and will abort
  against the current `.env.local`.
- No live credential appears anywhere in the fetched commit history. `.gitignore` correctly
  excludes `.env.local`, `.env*.local`, `private/`, and payroll CSV exports.

---

## 10. Strengths worth preserving

Recorded deliberately, because a health audit otherwise reads as a list of faults.

- **The `.kiro/specs` tree is exceptional.** Requirements, design, tasks, and captured *evidence*
  per feature — including live-vs-repo function diffs stored as JSON. Very few codebases of this
  size carry this.
- **Authorization is RLS-first**, and `migration-parity.test.ts` asserts as a test that *no policy
  gates on the assignee*. Expressing an architectural invariant as an executable assertion is the
  right instinct and should be extended, not diluted.
- **Comments explain "why," not "what."** `next.config.ts` on `serverExternalPackages`,
  `authorize.ts` on the empty-secret attack, `attendance/day/route.ts` on resolving the work date
  server-side rather than trusting the browser. These are the comments that stay true.
- **Property-based testing** with `fast-check` on the intake claim paths.
- **162 migrations, each with post-condition blocks**, plus a `supabase/verification/` tree holding
  query plans and probe results.

---

## Appendix: verified repository state at audit time

| | |
|---|---|
| `origin/main` | `e01a030978df283818bf24834a2b534169c995e1` |
| Local `HEAD` | `main` @ `e01a030`, level with origin |
| Local uncommitted work | none |
| Remote branches | 33 (`main` plus 32 unmerged feature/fix branches) |
| Node / npm used for audit | Node 22, npm 10.9.7 |
| Dependencies installed via | `npm ci` against committed `package-lock.json` |
