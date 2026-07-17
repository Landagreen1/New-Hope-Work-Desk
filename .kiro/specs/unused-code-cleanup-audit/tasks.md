# Implementation Plan

- [x] 1. Build the whole-system inventory and bug-condition evidence report
  - **Property 1: Bug Condition** - Evidence-Based Unused Element Classification
  - **CRITICAL**: Perform this exploration on the unfixed repository before deleting or editing any production element; retained proven-unused elements are the expected counterexamples.
  - **GOAL**: Inventory every repository-maintained element and determine whether `isBugCondition(input)` is true only when the evidence covers every applicable consumer class, all consumer sets and required side effects are empty, and the original repository still retains the element.
  - Record the baseline commit/worktree status, tracked-file inventory from `git ls-files`, Node/npm versions, lockfile identity, installed dependency state, timestamp, and environment-variable names/visibility only; never record secret values.
  - Inventory and classify all declarations, imports, exports, types, callbacks, JSX references, aliases, re-exports, module side effects, framework entry points, configs, public assets, package scripts, SQL/operational artifacts, and contract-only environment inputs across `src/**`, root source-like files, `scripts/**`, `public/**`, `supabase/**`, configuration, and operational documentation. Exclude `.next/` and `node_modules/` as cleanup subjects while retaining them as framework/tooling evidence.
  - Read and cite the applicable local Next.js 16 guidance under `node_modules/next/dist/docs/` before classifying `page.tsx`, `layout.tsx`, `route.ts`, `manifest.ts`, `proxy.ts`, metadata, global CSS, public assets, or other convention-discovered elements.
  - Run and record the immutable baseline commands with exact command, timestamp, exit code, and diagnostic summary: `npm run lint`; `npx tsc --noEmit`; `npx tsc --noEmit --noUnusedLocals --noUnusedParameters --incremental false`; and `npm run build`.
  - Preserve the known baseline distinction: lint has 23 pre-existing findings (18 errors, 5 warnings), strict type-check passes, the audit-only unused probe reports four declarations, and production build passes. Do not weaken config, add suppressions, or conflate unrelated lint errors with this cleanup.
  - Capture a normalized pre-cleanup route/proxy oracle from the production build: `/`, `/_not-found`, `/api/admin/users`, `/change-password`, `/login`, `/manifest.webmanifest`, `/setup`, `/tools`, `/tools/cs-intake`, `/tools/cs-intake/queue`, `/tools/renewals`, and `Proxy (Middleware)`, including relevant route classification and API method exports.
  - Construct repository-wide inbound/outbound and dependency-closure evidence using symbol names, import paths, aliases, file basenames, export names, type-only edges, JSX, callbacks, string literals, route/asset paths, CSS selectors, environment names, SQL object names, package-script paths, dynamic/computed lookups, and documentation/operational references.
  - Explicitly verify—do not blindly delete—the four findings in `src/features/renewals/RenewalsPage.tsx`: imports `AlertTriangle` (4:3), `CircleDollarSign` (8:3), and `FileClock` (13:3), plus `RenewalDrawer` parameter `onClose` (479:3). For each, verify value/type/JSX use, side effects, callers, prop types, callback creation, drawer-close behavior, and independently removable related-code closure.
  - Separately review root-level `CsIntakeLanding.tsx`, `IntakeQueue.tsx`, and `work-desk-app.tsx`: compare each semantically with canonical `src/` implementations and inspect package/release packaging, scripts, docs, manual handoff/deployment procedures, and plausible external consumers. Treat absence from the App Router/build manifest as insufficient proof and require operational-owner signoff before any orphan-file wave.
  - Perform high-risk contract review for environment/API/auth/Supabase/data/registry/script/SQL behavior: public/server env visibility and fallback precedence; proxy cookies/session refresh and role gates; `/api/admin/users` GET/POST/PATCH/DELETE callers and manager authorization; browser/server/admin clients; all `.from`, `.rpc`, `.channel`, `.storage`, and `.auth` contracts; `profiles`, `renewal_records`, `renewal_contacts`, `renewal_events`, `ensure_daily_availability_reset`, `renewal-contact-evidence`, and `work-desk-live`; `src/platform/module-registry.ts`; package/bootstrap commands, flags, and private input paths; migrations, RLS/policies, triggers, schema/seed/verification SQL, deployment, recovery, and upgrade procedures.
  - Produce `.kiro/specs/unused-code-cleanup-audit/audit-report.md` with one evidence record per candidate containing stable ID, identity/kind/signature/export status, exact location and baseline hash/commit, discovery output, local/repository reference queries (including zero-result scope), dependency closure, convention/dynamic/config/env/script/ops/integration review, confidence, production risk, disposition/approver, validation gaps, proposed wave, and exact rollback boundary.
  - Classify incomplete, ambiguous, external, framework, integration, operational, generated, High/Critical-risk, or unavailable-validation cases as `preserve`, `manual review`, or `defer`; only complete High-confidence proofs are eligible for `propose in wave`, and High/Critical-risk candidates additionally require affirmative owner/production review.
  - Use deterministic exhaustive classifier fixtures with the existing toolchain to exercise direct, type-only, dynamic, framework, side-effect, configuration, environment, script, integration, operational, and external consumer combinations. Because no test script or property-test library exists, automated randomized PBT is **optional** and must be a separately approved, exact-version dependency/lockfile change; record its absence as a validation gap rather than blocking the evidence audit.
  - Run the exploration against the unfixed repository and document concrete counterexamples. The expected initial counterexamples include the four static declarations; root-level duplicates remain candidates, not confirmed bugs, until external/operational non-use is disproved.
  - **EXPECTED OUTCOME**: The report identifies retained candidates satisfying or potentially satisfying `C(X)` while production code remains unchanged; this is the expected pre-fix failure state and confirms the cleanup defect without authorizing deletion.
  - Mark complete only after every inventory class and evidence-record field has been reviewed and candidate dispositions have been approved.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 1.8, 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 2.8_

- [x] 2. Establish observation-first preservation property checks before cleanup
  - **Property 2: Preservation** - Valid, Indirect, and Uncertain Contracts
  - **IMPORTANT**: Observe and record the unfixed system first. For every element where `isBugCondition(input)` is false, encode the observed contract as a preservation oracle rather than assuming intended behavior.
  - Snapshot exact pre-cleanup contracts for route paths/classification, API HTTP exports, `proxy` and `config.matcher`, metadata/manifest, module-registry IDs/roles/status/routes/labels, package scripts and CLI flags, validation configs/scopes, environment names/visibility/defaults/fallback order, public asset URLs, Supabase object names, migration ordering, and deployment/recovery procedures.
  - Confirm observation baselines for login, logout/session refresh, forced password change, setup fallback, manager-only administration, role-filtered navigation, dashboard/rotations, customer-service intake, intake queue claim/assignment/conversion, renewals import/assignment/contact evidence, workload handling, quote lifecycle, reports/exports, realtime refresh/fallback/reconnect, and error/permission paths.
  - Define the exact automated preservation gates to run before and after every cleanup wave:
    - `npm run lint`: no new diagnostic, severity increase, or unrelated diagnostic change; the 18-error/5-warning pre-baseline may remain, while only diagnostics tied to approved candidate IDs may disappear.
    - `npx tsc --noEmit`: exit code 0 before and after.
    - `npx tsc --noEmit --noUnusedLocals --noUnusedParameters --incremental false`: expected pre-wave findings are recorded; post-wave findings may decrease only for approved candidate IDs and must never gain a new finding.
    - `npm run build`: exit code 0 before and after, with exact normalized comparison of the route/proxy oracle; no path, route classification, API method export, manifest, or proxy difference is allowed unless separately approved outside this cleanup.
    - Exact diff/reference/config review: no unrelated formatting/refactor, dependency/config weakening, ignore/suppression, client/server boundary change, secret exposure, schema/data migration, or unclassified orphan is allowed.
  - Define targeted workflow smoke gates using authorized non-production credentials and safely controlled data. An authorized reviewer must manually run the local app with `npm run dev`; automation must not start a long-running dev server or watcher. Record pass/fail/not-run and evidence for affected routes, roles, API methods, auth/session redirects, Supabase reads/writes/RPC/storage/realtime, registry navigation, and applicable operational scripts/SQL verification.
  - Treat unavailable credentials, unsafe production operations, missing environment, or absent test automation as explicit gaps that prevent `fully validated` status and force preserve/defer where the gap affects candidate confidence.
  - Implement deterministic preservation fixtures using the existing toolchain for consumer/classifier and before/after contract snapshots. Randomized property-based automation is **optional** because the project has no test infrastructure; adding a PBT library requires a separate approved task with an exact pinned version and may not be bundled into a cleanup wave.
  - Run all currently available preservation checks on the unfixed repository.
  - **EXPECTED OUTCOME**: Preservation checks pass or exactly match the documented pre-existing baseline before implementation; uncertain and externally consumed elements remain protected.
  - _Requirements: 1.4, 1.5, 1.6, 2.2, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

- [x] 3. Apply only approved cleanup waves with isolated reversible boundaries
  - Do not begin any sub-task until tasks 1 and 2 are complete, the evidence report has disposition approval, and candidate IDs and affected workflows are fixed for the wave.
  - Keep each wave as a small isolated patch or explicitly approved commit with no unrelated formatting, refactor, dependency, configuration, schema, data, or documentation churn. Stop and roll back immediately on a failed gate or unexpected runtime result.

  - [x] 3.1 Execute Wave 1A for proven low-risk unused icon import specifiers
    - Reconfirm High confidence and Low risk for `AlertTriangle`, `CircleDollarSign`, and `FileClock`, including zero value/type/JSX references and no module side-effect dependency.
    - Remove only approved unused import specifiers; retain the active `lucide-react` import and all nearby mappings/behavior.
    - Keep this import-only closure separate from `onClose` and all unrelated renewals cleanup.
    - Run the full validation gates from task 2 and targeted renewals compile/render/navigation smoke checks.
    - _Bug_Condition: `isBugCondition(input)` is true only for each retained icon specifier whose complete evidence has no consumer or required side effect._
    - _Expected_Behavior: `expectedBehavior(result)` requires a complete High-confidence evidence record, independently proven closure, bounded wave, pre/post validation, and rollback with no audit-phase production change._
    - _Preservation: Preserve all active icon mappings, renewals rendering/actions, imports, and every element outside the three approved specifiers._
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 2.8, 3.1, 3.6, 3.7, 3.8, 3.9_

  - [x] 3.2 Execute Wave 1B for the proven `RenewalDrawer.onClose` dependency closure
    - Treat `onClose` independently from Wave 1A; trace every `RenewalDrawer` declaration and caller, prop/interface, callback factory, wrapper, close control, escape/backdrop behavior, and state transition.
    - Remove only the exact prop/caller closure whose non-use is independently proven. If the callback or signature is externally required, uncertain, or behaviorally relevant, preserve/defer the candidate instead.
    - Run the full validation gates and targeted drawer open/close/cancel/save, assignment, contact-evidence, keyboard/backdrop, and renewals workflow smoke checks.
    - _Bug_Condition: `isBugCondition(input)` applies only if complete evidence proves the parameter and every removed caller-side element have no static, callback, UI, dynamic, or external consumer._
    - _Expected_Behavior: `expectedBehavior(result)` from the design, including no orphaned prop/callback code and a reversible bounded wave._
    - _Preservation: Preserve drawer interaction semantics, state transitions, renewals data behavior, and any uncertain callback contract._
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 2.8, 3.1, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [x] 3.3 Execute separate Wave 2 patches for proven leaf exports, functions, types, styles, or assets
    - Create one bounded feature/dependency-closure patch at a time; do not combine unrelated candidates.
    - Require zero inbound static/type/dynamic/convention/registry/side-effect/operational/external edges and independently classify associated branches, helpers, tests, callbacks, styles, and assets.
    - For assets/styles, check JSX, CSS, metadata, manifest, documentation, direct public URLs, selectors, and runtime-generated names before approval.
    - Run full gates plus candidate-specific workflow checks after every individual patch; a warning disappearing without closure and behavior evidence is not sufficient.
    - _Bug_Condition: `isBugCondition(input)` from the design for each candidate and its independently proven-unused closure._
    - _Expected_Behavior: `expectedBehavior(result)` from the design for one bounded reversible patch at a time._
    - _Preservation: Preserve shared exports, public URLs, styles, side effects, and all verified or uncertain consumers._
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 2.7, 2.8, 3.1, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [x] 3.4 Execute separate Wave 3 patches for approved root duplicate/orphan files
    - Consider `CsIntakeLanding.tsx`, `IntakeQueue.tsx`, and `work-desk-app.tsx` only after semantic comparison, canonical import proof, package/release/manual/external-consumer review, complete per-declaration and side-effect evidence, and operational-owner signoff.
    - Use one file per reversible patch unless the evidence proves an inseparable closure. Preserve any file with unresolved external or operational use.
    - Re-run repository reference/dependency analysis, full validation gates, exact route/proxy comparison, relevant CS intake/queue/work-desk smoke checks, and release/package procedure review after each file patch.
    - _Bug_Condition: `isBugCondition(input)` must hold for every declaration and side effect in the candidate root file; location outside App Router and zero route imports do not satisfy the condition._
    - _Expected_Behavior: `expectedBehavior(result)` from the design plus explicit operational approval and one-file rollback boundary._
    - _Preservation: Preserve canonical `src/` modules, external/manual handoff contracts, release behavior, routes, and affected workflows._
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [x] 3.5 Review Wave 4 high-risk contracts and preserve by default
    - Re-review routes/framework conventions, auth/session/authorization, API, Supabase/data, environment/configuration, registries, scripts/bootstrap, setup/admin/deployment, and SQL/migration/RLS/policy/recovery candidates.
    - Default to `preserve`, `manual review`, or `defer`. Permit a dedicated cleanup patch only with complete High-confidence evidence, affirmative owner/production-state review, focused integration checks, and an independently rehearsed recovery path.
    - Never mix code cleanup with schema/data migrations; never run destructive SQL or account operations against production; preserve secret boundaries and legacy fallback precedence.
    - Run full gates and all applicable auth/API/Supabase/data/registry/script/SQL smoke or verification checks. Missing safe validation blocks full approval.
    - _Bug_Condition: `isBugCondition(input)` from the design, with complete external, operational, deployed-state, side-effect, and integration evidence._
    - _Expected_Behavior: `expectedBehavior(result)` plus required owner approval and dedicated recovery evidence for High/Critical-risk elements._
    - _Preservation: Preservation Requirements for routes, env, auth, API, Supabase/data, registry, scripts, SQL history, deployment, and recovery contracts._
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [x] 3.6 Verify the bug-condition exploration property after each wave
    - **Property 1: Expected Behavior** - Evidence-Based Unused Element Classification
    - **IMPORTANT**: Re-run the same classifier fixtures, inventory/reference analysis, and candidate checks from task 1; do not replace them with a weaker new check.
    - Verify every approved candidate and its exact proven closure are absent, no unclassified orphan remains, and only the approved evidence-record dispositions changed.
    - Re-run the audit-only unused probe and verify only approved findings disappear; update evidence records with post-wave commands, outputs, diff, and disposition.
    - **EXPECTED OUTCOME**: The same exploration property now passes for the wave, confirming removal of all and only the proven bug-condition elements.
    - _Requirements: 2.1, 2.3, 2.4, 2.6, 2.7, 2.8_

  - [x] 3.7 Verify preservation properties after each wave
    - **Property 2: Preservation** - Valid, Indirect, and Uncertain Contracts
    - **IMPORTANT**: Re-run the same snapshots, deterministic fixtures, full gates, route comparison, and applicable workflow checks from task 2; do not write substitute checks after seeing the diff.
    - Verify all preserved/review/deferred elements remain present and route, env, framework, API/auth/Supabase/data, registry, script, SQL/operations, validation, and user-workflow contracts are equivalent to the pre-wave baseline.
    - **EXPECTED OUTCOME**: All checks pass or match only the explicitly documented pre-existing diagnostics, with no new diagnostic, route/contract difference, hidden exclusion, secret exposure, or workflow regression.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [x] 3.8 Exercise and document rollback for each isolated wave
    - Before approval, record candidate IDs, exact files/diff or approved commit boundary, baseline commit, restoration command/procedure, and expected restored evidence.
    - On any failed validation, unexpected runtime result, or rejected review, revert only that wave; do not use destructive workspace-wide reset and do not alter unrelated work.
    - Re-run strict type-check, production build, normalized route/proxy comparison, affected workflow checks, and candidate-specific preservation gates to prove restoration of the prior known-good state.
    - Verify rollback requires no data repair, schema migration, secret rotation, or unrelated production change; otherwise the wave was not acceptably reversible and must remain deferred.
    - _Requirements: 2.6, 2.7, 3.8, 3.9_

- [x] 4. Checkpoint and publish the final audit/cleanup report
  - Ensure every executed wave passes `npm run lint` diagnostic comparison, `npx tsc --noEmit`, `npx tsc --noEmit --noUnusedLocals --noUnusedParameters --incremental false`, `npm run build`, exact route/proxy comparison, diff/reference/config review, and all applicable targeted smoke/integration checks.
  - Verify the final route oracle still contains every baseline route and `Proxy (Middleware)` with unchanged relevant classification and `/api/admin/users` HTTP contracts.
  - Reconcile every inventory candidate to exactly one final disposition: removed in approved wave, preserved, manual review, or deferred; no candidate may disappear from reporting.
  - Update the audit report with before/after command outputs and timestamps, route comparisons, smoke evidence, validation gaps, approvals, wave boundaries, rollback results, final findings/counts, and a concise list of unchanged production contracts.
  - Explicitly report optional PBT automation as not configured unless a separately approved exact-version test-infrastructure change was completed; do not claim randomized property coverage from deterministic fixtures.
  - Confirm no unrelated refactor, dependency/config change, suppression, exclusion, route change, environment rename, SQL/schema/data operation, or secret value entered any cleanup wave.
  - Obtain reviewer confirmation for unresolved external/operational consumers and all High/Critical-risk dispositions; ask the user if questions or validation gaps remain.
  - _Requirements: 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_
