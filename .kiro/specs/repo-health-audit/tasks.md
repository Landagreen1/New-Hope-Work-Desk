# Tasks: Repository Health Remediation

**Authored by:** Claude (Cowork), 20 August 2026
**Evidence:** `evidence-report.md` in this folder, audited at `origin/main` @ `e01a030`
**Status:** awaiting Oscar's spec. Tasks 1–3 are the agreed first three items. Nothing here has
been started.

Ordered deliberately. Task 1 first, because nothing below it stays fixed without it.

---

## Task 1: Add CI and repository hygiene files [done: false]

### Description
There is no `.github/` directory in this repository. Add one. A workflow running `tsc --noEmit`
and `vitest --run` on every push completes in under two minutes and would have blocked all four
TypeScript errors and all five test failures recorded in `evidence-report.md` before they reached
`main`. Every other task on this list is undone by the next change without this one in place.

### Sub-tasks
- [ ] Add `.github/workflows/ci.yml` — Node 22, `npm ci`, then `tsc --noEmit`, `eslint .`,
      `vitest --run`, `next build`, on push and pull_request
- [ ] Decide whether `eslint` is blocking or advisory in CI while the 52 errors in Task 4 remain
      outstanding — a job that always fails red is a job everyone learns to ignore
- [ ] Add `.github/CODEOWNERS`
- [ ] Add `.github/pull_request_template.md`, including a line for which AI tool produced the
      change and which `.kiro/specs/` folder covers it
- [ ] Add `.github/ISSUE_TEMPLATE/bug_report.md` and `feature_request.md`
- [ ] Add `.github/dependabot.yml` for npm, grouped, weekly
- [ ] Add `SECURITY.md`
- [ ] Add `.gitattributes` — `* text=auto eol=lf`, plus `*.sql text eol=lf`. Removes the CRLF class
      of problem that `migration-parity.test.ts` currently works around in code
- [ ] Confirm the workflow passes on a branch before opening it against `main`

---

## Task 2: Return `main` to green — 4 TypeScript errors, 5 failing tests [done: false]

### Description
All nine failures are tests that pinned behaviour which later commits deliberately changed. None
indicates a defect in shipped behaviour. Full analysis in `evidence-report.md` §2 and §3.

One sub-task is a question for Oscar, not a code change, and must be answered before the
corresponding test is touched — updating an assertion is the same as approving the new behaviour.

### Sub-tasks
- [ ] `rc-claim-bug-condition.test.ts:131` and `rc-claim-preservation.test.ts:216,273,330` — extend
      the `fast-check` arbitraries to the 58 fields commit `e01a030` added to `CsIntakeSubmission`
- [ ] Extract those arbitraries into one shared factory so the next schema addition breaks one call
      site rather than four
- [ ] `cancellations-table.test.tsx:85` — update the expected cell array from `"Mar 4, 2026"` to
      `"03/04/2026"` per commit `caf7883`
- [ ] `renewals-table.test.tsx` — same correction, same cause
- [ ] **Ask Oscar:** commit `37b5441` granted Quote Center access to commercial agents, and that
      grant also makes `editSharedDraft('commercial')` return `true`. Was shared-draft *editing*
      intended, or only *viewing*? If only viewing, the fix belongs in the permission function and
      not in the test
- [ ] `quote-center-permissions.test.ts` — apply the fix the answer above dictates
- [ ] `migration-parity.test.ts` — repair the parity oracle so `CORE` composes the base migration
      **plus every later migration that alters the same CHECK constraint**. `generated_application`
      is added by `ALTER` in `v1.17.0-market-directory.sql:458`. Do not simply add the value to the
      expected list — the oracle's purpose is to catch drift, and as written it will emit a false
      failure every time a constraint is legitimately widened
- [ ] Re-run `tsc --noEmit`, `vitest --run`, and `next build` and record the results in
      `evidence-report.md` as a dated follow-up section

---

## Task 3: Security and dependency triage [done: false]

### Description
Six high and two moderate advisories. The Next.js one is the only one that warrants its own
reasoning; the rest are routine. See `evidence-report.md` §5, including the mitigating context —
`src/proxy.ts` does not gate access, so the middleware-bypass advisory is not an auth bypass in
this codebase. Take the patch regardless.

This needs an upgrade-and-verify plan. `npm audit fix` unattended on a Next 16 / React 19 tree is
how a working build stops working.

### Sub-tasks
- [ ] Upgrade `next` past the App Router middleware/proxy bypass and Server Actions DoS advisories
- [ ] Re-run the full suite and `next build` after the Next upgrade, before touching anything else
- [ ] Verify `src/proxy.ts` session refresh still behaves — log in, let a session age, confirm the
      cookie refreshes and no route regressed to unauthenticated
- [ ] Resolve `postcss`. It is pinned to `8.5.10` via `overrides` in `package.json`; the advisory
      covers `<=8.5.22`, so the pin must move
- [ ] Address `sharp`, `js-yaml`, `nanoid`, `brace-expansion` — transitive, expected to clear with
      the Next upgrade; confirm rather than assume
- [ ] Address `exceljs` → `uuid` (moderate). Verify the Sales Reporting Center XLSX export still
      produces a correct workbook afterward
- [ ] Re-run `npm audit` and record the closing counts in `evidence-report.md`

---

## Task 4: Decide the `react-hooks/set-state-in-effect` question [done: false]

### Description
39 of the 52 lint errors are one repeated pattern — `useEffect(() => { void refresh(); }, [refresh])`
— across the feature modules. At 39 sites this is a project convention, not an accident. It is a
cascading-render smell, not a crash.

This is **one architectural decision, not 39 fixes.** Fixing it opportunistically as files are
touched leaves the codebase in two idioms simultaneously, which is worse than either choice made
deliberately.

### Sub-tasks
- [ ] Decide: migrate the pattern, or downgrade the rule with a written reason in
      `eslint.config.mjs`
- [ ] Record the decision and its reasoning in `.kiro/steering/` so it does not get relitigated
- [ ] Separately, read the four `react-hooks/purity`, `react-hooks/refs`, and
      `react-hooks/immutability` errors individually — those rules fire on genuinely incorrect code
      more often than not, and should not be swept in with the 39
- [ ] Triage the 138 `no-unused-vars` warnings

---

## Task 5: Document `CRON_SECRET` and define the cron schedule [done: false]

### Description
`CRON_SECRET` is referenced six times in source and zero times in any document. There is no
`vercel.json`. Anyone deploying by following this project's own setup guide ships both the
cancellation scheduler and the renewal SMS scheduler silently inert. The guard is fail-closed, so
this is a documentation defect rather than a vulnerability — but it is the cheapest high-value fix
in the repository.

### Sub-tasks
- [ ] Add `CRON_SECRET` to `.env.example` with a comment explaining what it protects and that an
      empty value must never be treated as unset
- [ ] Document it in `LIVE-DEPLOYMENT-GUIDE.md` and `SETUP-CHECKLIST.md`
- [ ] Add `vercel.json` defining the cron schedule for `/api/cancellations/scheduler` and
      `/api/renewals/sms/scheduler`
- [ ] Document `SUPABASE_JWKS_URL`, `SUPABASE_PROJECT_REF`, and `SUPABASE_ACCESS_TOKEN` in
      `.env.example`, marked clearly as tooling-only and not required by the running application
- [ ] Fix `scripts/assign-schedules.mjs` to accept `SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY`,
      matching the other ten call sites
- [ ] Remove the dead `RINGCENTRAL_*` prefix from the test files so it cannot re-enter

---

## Task 6: Repository tidying [done: false]

### Description
Lowest priority, no functional effect. Grouped so it can be done in one pass rather than
piecemeal.

### Sub-tasks
- [ ] Refresh `README.md` — it states v0.9.4 while `package.json` says 0.9.4.1, `CHANGELOG.md`
      opens at v1.16.0, and migrations reach v1.17.0. It does not mention Specialty Quotes, Time &
      Attendance, Cancellations, or the Sales Reporting Center
- [ ] Reconcile the version stated across `README.md`, `package.json`, and `CHANGELOG.md`
- [ ] Move the eleven `UPGRADE-v*.md`, `TEST-CHECKLIST-v0.9.4.1.md`, and
      `RENEWAL-SMS-SESSION-NOTES.md` into `docs/history/`
- [ ] Reconcile `README-FIRST.md` and `README-FIRST.txt` — near-duplicates
- [ ] Remove the root-level `work-desk-app.tsx`, which duplicates `src/components/work-desk-app.tsx`
- [ ] Relocate the two loose root `.sql` files into `supabase/verification/`
- [ ] Prune remote branches already merged into `main`; confirm with Oscar which of the 32 unmerged
      branches are live work before deleting anything
