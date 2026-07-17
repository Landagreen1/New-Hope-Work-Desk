# Observation-First Preservation Baseline

Recorded on 2026-07-15T23:08:18.0267299-04:00 from the unfixed repository at commit `37589c72c5488a2daae07844ffcdc035527e1e3a`. This task changed no production source, configuration, dependency, SQL, asset, environment contract, or operational procedure. Secret values were not read or recorded.

## Property and artifacts

**Property 2: Preservation — Valid, Indirect, and Uncertain Contracts.** For every repository element for which `isBugCondition(input)` is false, the observed contract is the oracle. Any direct, type-only, dynamic, framework, side-effect, configuration, environment, script, integration, operational, or external consumer; incomplete evidence; uncertainty; or required side effect forces preservation/review rather than cleanup.

- `preservation-oracle.mjs` derives a normalized contract snapshot and compares its SHA-256 digest with `preservation-baseline.json`.
- `preservation-oracle.test.mjs` exhaustively checks all 2,047 non-empty combinations of the 11 consumer classes, incomplete/uncertain/side-effect boundaries, exact contract equality, and validation-output normalization. It uses `node:test`; no dependency was added.
- `preservation-gates.mjs` implements repeatable pre/post gates for human lint output plus exact normalized lint diagnostics, strict TypeScript, audit-only unused diagnostics, production build routes/proxy, contract digest, diff whitespace, tracked-file allowlisting, and protected validation/dependency configs.
- Randomized property-based testing is optional and **not configured**. No PBT dependency or lockfile change was made.

The oracle records exact paths/classifications and API methods; proxy export/matcher/session-cookie refresh chain; metadata/manifest; module IDs, labels, descriptions, routes, roles, and status; package scripts, bootstrap flags, and private input paths; TypeScript/ESLint/Next/PostCSS/npm scopes; environment names, visibility, defaults, and fallback order; public URLs and asset hashes; Supabase tables/RPCs/storage/realtime/auth names; migration/verification order and SQL hashes; and deployment/recovery/upgrade procedure hashes and observations. The snapshot does not inspect `.env.local` and explicitly records `secretValuesCaptured: false`.

Installed Next.js 16 guidance consulted: `page.md`, `layout.md`, `route.md`, `proxy.md`, `public-folder.md`, and metadata `manifest.md` under `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/`.

## Unfixed automated baseline

| Gate | Result | Preserved evidence |
|---|---|---|
| `npm run lint` | Expected baseline failure, exit 1 | Exactly 23 findings: 18 errors and 5 warnings. No task-file diagnostic remains. The machine-normalized diagnostic fingerprint is `c32476569a96e35b20f8aa885b170e8ff08f1f2d8d4f8a512e45d8d3b4aeeb2e`. |
| `npx tsc --noEmit` | Pass, exit 0 | Strict current configuration passes. |
| `npx tsc --noEmit --noUnusedLocals --noUnusedParameters --incremental false` | Expected discovery failure, exit 1 | Exactly TS6133 at `RenewalsPage.tsx` 4:3 `AlertTriangle`, 8:3 `CircleDollarSign`, 13:3 `FileClock`, and 479:3 `onClose`. |
| `npm run build` | Pass, exit 0 | Next.js 16.2.10 production build compiled, type-checked, collected data, and generated static pages. |
| Normalized route/proxy oracle | Exact | `ƒ /`, `○ /_not-found`, `ƒ /api/admin/users`, `ƒ /change-password`, `ƒ /login`, `○ /manifest.webmanifest`, `○ /setup`, `ƒ /tools`, `ƒ /tools/cs-intake`, `ƒ /tools/cs-intake/queue`, `ƒ /tools/renewals`, and `ƒ Proxy (Middleware)`. API exports are `GET`, `POST`, `PATCH`, `DELETE`; runtime is `nodejs`. |
| `node --test ".kiro/specs/unused-code-cleanup-audit/preservation-oracle.test.mjs"` | Pass | Final run: 6/6 tests, including 2,047 consumer combinations, exact snapshot equality, and validation normalizers. |
| `node ".kiro/specs/unused-code-cleanup-audit/preservation-gates.mjs" --run` | Pass | Consolidated gate matched lint fingerprint/counts, strict TypeScript, four audit-only findings, build routes/proxy, exact contract digest, empty tracked diff, and protected configs. |
| `git diff --check` | Pass | No tracked whitespace error. `git status --short` reports the pre-existing untracked `.kiro/` spec tree; production tracked files remain unchanged. |

## Required pre/post wave gates

Run from repository root before and after each separately approved cleanup wave:

```powershell
node .kiro/specs/unused-code-cleanup-audit/preservation-oracle.mjs --compare
node --test .kiro/specs/unused-code-cleanup-audit/preservation-oracle.test.mjs
node .kiro/specs/unused-code-cleanup-audit/preservation-gates.mjs --run --allow=path/to/approved-file.ts
```

The automated runner executes the exact human `npm run lint` gate and a machine-readable ESLint pass. Lint may remain at the recorded baseline; no new diagnostic, severity increase, changed unrelated diagnostic, or fingerprint difference is accepted. For an approved cleanup wave, update the baseline only after review so that only diagnostics mapped to approved candidate IDs may disappear. Strict TypeScript and build must stay at exit 0. Audit-only unused findings may only decrease for approved IDs and must never gain an entry. Build paths/classifications, API exports, manifest, and proxy must remain exact.

`--allow` is a comma-separated exact tracked-file allowlist. The gate rejects any other tracked diff and always rejects changes to `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `next.config.ts`, and `.npmrc`. Reviewer diff/reference review must also confirm: no unrelated formatting/refactor; ignore/suppression/exclusion; dependency or client/server boundary change; secret exposure; schema/data operation; unclassified orphan; environment rename/fallback change; public URL change; or operational procedure change. Candidate-specific repository references and dependency closure must be rerun and attached to the wave evidence. If any check differs unexpectedly, stop and restore only the isolated wave, then rerun strict TypeScript, build, oracle, and affected smoke checks.

## Source-observed workflow baselines

These are observations from current source and documentation, not claims of runtime execution:

- Auth/session: missing Supabase config routes to setup; absent claims/inactive users route to login; proxy mirrors cookies and refreshes claims; logout remains an authenticated-session operation.
- Password/setup/admin: `must_change_password` routes to change-password; completion updates auth then calls `complete_password_change`; admin GET/POST/PATCH/DELETE require an active manager and preserve observed 400/401/403/404/409/503 paths.
- Navigation/dashboard/rotations: active modules are role-filtered through the registry; dashboard data invokes daily reset and retains independent WhatsApp, RingCentral, and workload rotations.
- CS intake/queue: create/edit/list/submit, claim, manager assignment, return, and conversion contracts remain present.
- Renewals/workload: import, assignment, aliases, contacts/evidence storage, events, workflow/manager updates, re-quote, workload list/reassign/void remain present.
- Quote lifecycle/reports/exports: active work, Pending Pricing, Sold/Not Sold outcomes, reports, filters, and export UI remain source-observed contracts.
- Realtime/errors: all recorded channels remain; 60-second fallback, tab visibility/focus, online/reconnect refresh, and missing-config/auth/role/permission/integration error paths remain preservation targets.

## Authorized manual smoke evidence

Automation did **not** start `npm run dev`. An authorized reviewer must use non-production credentials and controlled disposable records. Do not use production accounts/data, run bootstrap resets, execute migrations, or perform recovery/destructive SQL merely to satisfy this checklist. For each row record `PASS`, `FAIL`, or `NOT RUN`, reviewer, timestamp, environment, controlled record IDs, and redacted evidence link/notes.

| Area | Targeted reviewer steps | Status | Evidence fields |
|---|---|---|---|
| Setup/login/logout/session | With missing config confirm setup fallback; with non-production config test invalid login, active login, logout, expiry, refresh, and inactive account. | NOT RUN | Reviewer: —; time: —; env: unavailable; evidence: no `.env.local`/credentials. |
| Forced password | Use a disposable forced-change user; verify redirect, validation, successful change, claim refresh, and return to `/`. | NOT RUN | Reviewer/time/user ID/redacted capture: — |
| Role/navigation | Test agent, customer-service, and manager registry links plus denied direct routes. | NOT RUN | Reviewer/time/role matrix: — |
| Admin API | As anonymous, non-manager, and manager exercise GET/POST/PATCH/DELETE with disposable users; verify statuses, self/final-manager/active-work protections, and server-only secret handling. | NOT RUN | Reviewer/time/disposable IDs/redacted responses: — |
| Dashboard/rotations | Verify three independent queues, availability reset, take/pass/update, manager reorder/reassign, and controlled rollback. | NOT RUN | Reviewer/time/controlled records: — |
| CS intake/queue | Create/edit/submit an intake, claim/assign/return/convert it, and verify role/validation/error paths. | NOT RUN | Reviewer/time/intake ID/quote ID: — |
| Renewals | Import controlled rows, assign, add/download/delete contact evidence, update workflow, re-quote, and verify permission/errors. | NOT RUN | Reviewer/time/import/record/evidence IDs: — |
| Workload/quotes/reports/exports | Exercise linked/manual workload, quote through Price Sent to Sold/Not Sold, reports/filters, and export contents. | NOT RUN | Reviewer/time/record IDs/export checksum: — |
| Realtime/fallback | Use two sessions; verify live event, <=60-second fallback, hidden-tab return, offline/online, and reconnect refresh. | NOT RUN | Reviewer/time/session matrix/timings: — |
| Scripts/SQL/operations | In an isolated non-production environment only, review bootstrap dry prerequisites/flags and run approved read-only verification SQL; verify deployment/rollback procedure. | NOT RUN | Reviewer/time/environment/query evidence: — |

Any `FAIL` blocks the wave. Any relevant `NOT RUN` prevents “fully validated” and forces preserve/defer for affected candidates.

## Validation gaps and status

- `.env.local` is absent and `private/bootstrap-users.json` is absent. Authorized non-production credentials, role accounts, controlled data, and a configured Supabase project were unavailable.
- No package `test` script or existing automated browser/integration suite covers runtime workflows.
- Runtime auth/session, API status semantics, Supabase reads/writes/RPC/storage/realtime, role UI, and operational scripts/SQL were not executed.
- Unsafe production bootstrap, password reset, migration, recovery, destructive SQL, account, schema, and data operations were intentionally not run.
- Task 1’s required `audit-report.md`, candidate dispositions, approver signoff, and candidate-to-workflow mapping are absent. Task 2 does not recreate task 1; this missing prerequisite blocks authorization of any cleanup wave.
- The repository’s `.kiro/` tree is untracked as a whole, so Git cannot provide tracked diffs for individual spec artifacts until the owner chooses to add them. The preservation files themselves are listed below.

**Status: implemented and statically/build validated, but not fully runtime validated.** All currently safe and available checks match the unfixed baseline. Missing task-1 approval, environment, credentials, workflow automation, and manual smoke evidence require preservation/defer where relevant and prevent claiming the overall cleanup is ready for execution.

## Active approved-wave validation expectation

After reviewed Wave 1B removed only UC-004 (`RenewalDrawer.onClose` and its exact ignored caller/type closure), the immutable contract snapshot digest remains unchanged. `preservation-baseline.json` retains the unfixed command evidence under `preCleanupValidation` and uses `validation` for the current approved-wave gate: lint remains 18 errors/5 warnings with fingerprint `738c8e9eabe8bc2477f640bee2e885db41b73d781fe59bac1e33fa2963de91b5`; strict TypeScript remains exit 0; and the unused probe contains only UC-001–UC-003. This is the baseline transition explicitly permitted above—only the approved UC-004 production diagnostic disappeared. The already documented untracked audit-fixture warning remains outside the production patch and accounts for the unchanged warning total. The same oracle, deterministic fixture, and consolidated runner are still required; no check was replaced or weakened.
