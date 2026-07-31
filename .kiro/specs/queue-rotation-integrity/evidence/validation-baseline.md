# Validation baseline (before any implementation)

Captured on branch `fix/queue-rotation-integrity` at baseline commit `09b9901`, with **no tracked file
modified**. `git status --porcelain` at capture time:

```
?? .kiro/specs/queue-rotation-integrity/
?? .kiro/specs/rc-claim-duplicate-quote-fix/
?? .kiro/steering/queue-rotation.md
```

Only untracked additions. Everything below is therefore **pre-existing on `main`**, not caused by this
spec. Phase 6 must compare against these numbers rather than expecting a clean tree.

## Tooling

`package.json` has **no `test` script**. Tests run through `npx vitest --run`.

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint",
  "bootstrap-users": "node --env-file=.env.local scripts/bootstrap-users.mjs"
}
```

`vitest.config.ts` only collects `src/**/*.{test,spec}.{ts,tsx}` with `environment: 'node'`.
**Consequence for Phase 4:** new rotation tests must live under `src/`, or `vitest.config.ts` must be
extended to include the spec directory. Test deps available: `vitest ^4.1.10`, `fast-check ^4.9.0`.
There is no SQL/pgTAP runner and no integration-test harness in the repo today — one must be built
(task 4.1).

## `npx tsc --noEmit`

```
Total tsc errors: 4
   3  src/features/cs-intake/__tests__/rc-claim-preservation.test.ts
   1  src/features/cs-intake/__tests__/rc-claim-bug-condition.test.ts
```

All four are the same class: a `fast-check` arbitrary is missing 21–25 newer `CsIntakeSubmission` fields
(`insured_middle_name`, `mc_number`, `mcs150_date`, `cargo_type`, …), so
`Arbitrary<{...}>` is not assignable to `Arbitrary<CsIntakeSubmission>`. Introduced by the earlier
`rc-claim-duplicate-quote-fix` work and unrelated to queue rotation.

**Phase 6 gate:** `tsc` must report **exactly these 4 errors and no others**. Any fifth error is a
regression from this spec.

## `npm run lint`

```
187 problems (58 errors, 129 warnings)
2 errors and 0 warnings potentially fixable with `--fix`
exit code 1
```

Dominated by `react-hooks/set-state-in-effect` across existing feature components (for example
`src/features/workload/WorkloadLog.tsx:126`).

**Phase 6 gate:** total must not exceed 187 problems / 58 errors. This spec must not add lint errors.
Do **not** attempt a repo-wide lint cleanup inside this bugfix.

## `npx vitest --run`

```
Test Files  18 passed (18)
     Tests  241 passed (241)
  Duration  808ms
exit code 0
```

**Phase 6 gate:** all 241 existing tests must still pass, plus the new rotation suites. No test may be
skipped or filtered.

## `npm run build`

Not captured in this baseline pass. Capture before implementation begins so Phase 6 has a comparison point.

## Live database baseline

Captured separately:

- `evidence/live-audit.json` — catalog, rotation state, roster, turn events, invariant verdicts
- `evidence/live-audit2.json` — manager functions, business date, day state
- `evidence/live-audit3.json` — `audit_log` eligibility history, timer columns
- `evidence/live-functions/*.sql` — 29 `pg_get_functiondef` dumps

`diagnostics/production-queue-diagnostic.sql` self-check at capture time:

```
wraparound_verdict      : BROKEN (RC-1) - position filter sits in WHERE, wraparound lost
guards_null_position    : false
restricts_to_role_agent : true
```

Diagnostic script validation: **25/25 statements executed successfully** against production
(`scripts/validate-diagnostic.mjs`).
