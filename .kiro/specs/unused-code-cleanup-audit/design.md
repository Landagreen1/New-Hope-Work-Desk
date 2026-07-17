# Unused Code Cleanup Audit Bugfix Design

## Overview

This bugfix is an evidence-first repository audit followed by a proposed, phased cleanup. The defect is not merely that an element has no local reference; it is that a repository-maintained element remains after complete evidence establishes that it has no valid static, runtime, framework-convention, configuration, environment, route, integration, operational, or external consumer. The design therefore treats uncertain non-use as preservation, not as permission to delete.

This phase changes no production code. It inventories the whole repository, records current validation baselines, creates a reproducible evidence record for every candidate, and groups only proven-unused dependency closures into small reversible cleanup waves. Framework entry points, Supabase/auth/API/data behavior, environment contracts, package scripts, SQL history, public assets, side-effect imports, registries, and documented operational procedures are explicit consumer classes.

The repository is a Next.js 16.2.10 App Router application using React 19.2.4, strict TypeScript, ESLint, Supabase browser/server clients, an authentication proxy, a protected user-administration API, operational scripts, and versioned SQL artifacts. Existing project tooling is the default audit mechanism. No new dependency, weakened rule, suppression, exclusion, route change, SQL change, or environment rename is part of this design.

### Observed Pre-Cleanup Baseline

The following baseline was observed during design inspection after restoring lockfile-pinned dependencies with `npm ci` (368 packages; no tracked production file changed):

| Check | Command | Result | Evidence |
|---|---|---|---|
| Lint | `npm run lint` | Failed, pre-existing | 23 findings: 18 errors and 5 warnings. Four warnings are unused-symbol signals in `src/features/renewals/RenewalsPage.tsx`: `AlertTriangle` at 4:3, `CircleDollarSign` at 8:3, `FileClock` at 13:3, and parameter `onClose` at 479:3. Other findings must not be conflated with unused-code cleanup. |
| Strict type check | `npx tsc --noEmit` | Passed | Exit code 0 under the current strict `tsconfig.json`. |
| Audit-only unused probe | `npx tsc --noEmit --noUnusedLocals --noUnusedParameters --incremental false` | Failed as an expected discovery signal | Exactly the same four unused declarations above were reported. This command does not alter `tsconfig.json`. |
| Production build | `npm run build` | Passed | Compilation, TypeScript, page-data collection, and static generation succeeded. |
| Automated tests | No `test` script exists | Not run | `package.json` exposes `dev`, `build`, `start`, `lint`, and `bootstrap-users`; unavailable automated workflow coverage prevents claiming complete runtime validation. |

The successful build discovered these contracts: `/`, `/_not-found`, `/api/admin/users`, `/change-password`, `/login`, `/manifest.webmanifest`, `/setup`, `/tools`, `/tools/cs-intake`, `/tools/cs-intake/queue`, `/tools/renewals`, and the framework `Proxy (Middleware)`. This manifest is the initial route-preservation oracle, not evidence that non-bundled files are automatically safe to remove.

## Glossary

- **Repository_Element (X)**: A repository-maintained variable, parameter, import, type, function, component, export, file, asset, package script, configuration entry, environment name, SQL artifact, or related dependency closure.
- **Bug_Condition (C)**: `X` is retained even though a complete audit proves that no valid consumer exists and no required side effect or contract depends on it.
- **Property (P)**: The audit classifies `X` with complete evidence and, when `C(X)` is true, proposes only the independently proven-unused closure for a reversible cleanup wave.
- **Preservation (¬C)**: Any element with a verified or uncertain static, runtime, conditional, dynamic, framework, configuration, environment, route, integration, operational, or external consumer remains unchanged.
- **Valid_Consumer**: Any use that requires an element to exist or behave as it currently does, including imports, calls, type references, callbacks, JSX, string-selected entries, side effects, Next.js discovery, package scripts, deployment configuration, environment lookup, SQL migration history, database objects, documentation-driven operations, or external clients.
- **Candidate**: An element surfaced by static analysis, reference analysis, duplication review, or manual inspection. Candidate status alone never authorizes removal.
- **Dependency_Closure**: The candidate plus branches, helper functions, types, exports, styles, assets, tests, callbacks, and side effects whose necessity may change with it.
- **Evidence_Record**: The auditable record containing exact identity, location, observed references, consumer checks, confidence, production risk, related-code impact, disposition, validation, and rollback information.
- **Confidence**: Strength of the non-use proof: High, Medium, Low, or Unknown.
- **Production_Risk**: Consequence if the classification is wrong: Low, Medium, High, or Critical. Risk is independent of confidence and can override cleanup eligibility.
- **Framework_Convention**: A Next.js-discovered contract such as `page.tsx`, `layout.tsx`, `route.ts` HTTP exports, `manifest.ts`, `proxy.ts`, `config.matcher`, metadata exports, global CSS, or a file served from `public/`.
- **Operational_Consumer**: A release, setup, migration, verification, bootstrap, deployment, recovery, or administrator procedure that consumes an artifact without importing it into application code.
- **F**: The original repository and its current observable behavior before a cleanup wave.
- **F′**: The repository after one bounded cleanup wave.

## Bug Details

### Bug Condition

Let `R` be the set of repository-maintained elements. For `X ∈ R`, let `Consumers(X)` be the union of static, type-level, runtime, conditional, dynamic, side-effect, framework, route, configuration, environment, script, integration, operational, and external consumers. Let `Complete(E_X)` mean that the evidence record covers every applicable consumer class and records unavailable checks. Let `RequiredSideEffect(X)` identify initialization, registration, CSS, cookie, auth refresh, database, or other behavior that occurs by presence or evaluation rather than by reading a returned value.

The formal bug condition is:

`C(X) = X ∈ R ∧ Complete(E_X) ∧ Consumers(X) = ∅ ∧ ¬RequiredSideEffect(X) ∧ Retained(F, X)`

If evidence is incomplete, external use is plausible, or any consumer exists, `C(X)` is false. In particular, “zero ordinary imports” is not equivalent to `Consumers(X) = ∅`.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type AuditSubject
  OUTPUT: boolean

  LET X := input.element
  LET E := input.evidence

  RETURN isRepositoryMaintained(X)
         AND evidenceCoversAllApplicableConsumerClasses(E)
         AND repositoryWideStaticReferences(E) IS EMPTY
         AND typeLevelReferences(E) IS EMPTY
         AND runtimeAndConditionalConsumers(E) IS EMPTY
         AND dynamicAndStringSelectedConsumers(E) IS EMPTY
         AND frameworkConventionConsumers(E) IS EMPTY
         AND configurationEnvironmentAndScriptConsumers(E) IS EMPTY
         AND integrationOperationalAndExternalConsumers(E) IS EMPTY
         AND requiredSideEffects(E) IS EMPTY
         AND originalRepositoryRetains(X)
END FUNCTION
```

The expected audit predicate is:

```
FUNCTION expectedBehavior(result)
  INPUT: result of type AuditDecision
  OUTPUT: boolean

  RETURN result.evidenceRecord IS complete
         AND result.confidence = HIGH
         AND result.disposition = PROPOSE_REVERSIBLE_CLEANUP
         AND everyElement(result.dependencyClosure) IS independentlyProvenUnused
         AND result.wave.hasBoundedScope
         AND result.wave.hasPreAndPostValidation
         AND result.wave.hasRollbackProcedure
         AND productionCodeWasNotChangedDuringAudit
END FUNCTION
```

### Repository Inventory Boundary

The audit starts from `git ls-files` and supplements it with filesystem/configuration inspection so ignored runtime inputs are represented by contract name without reading or reporting secret values.

1. **Application source**: all `src/app`, `src/components`, `src/features`, `src/lib`, `src/platform`, and `src/proxy.ts` files.
2. **Top-level source-like files**: `CsIntakeLanding.tsx`, `IntakeQueue.tsx`, and `work-desk-app.tsx`, which coexist with active `src/` implementations and therefore require duplicate/orphan analysis.
3. **Framework/configuration**: `next.config.ts`, `next-env.d.ts`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`, `.npmrc`, `.gitignore`, `src/app/globals.css`, app convention files, and `public/` assets.
4. **Package/runtime entry points**: `package.json`, `package-lock.json`, and `scripts/bootstrap-users.mjs`, including command-line flags and its private runtime input contract.
5. **Database/operations**: `supabase/schema.sql`, seed template, every versioned migration, verification SQL, top-level health/readiness SQL, deployment/setup/upgrade/checklist documents, and release history.
6. **Generated/third-party outputs**: `node_modules/` and `.next/` are excluded as cleanup subjects but used as tool/framework evidence. `next-env.d.ts` is generated yet is preserved as a framework/type contract.
7. **Environment**: `.env.example`, documented Vercel variables, and code lookups are inventoried by variable name and visibility only. `.env.local` values and secrets must never be copied into the report.

Before interpreting a Next.js convention, the implementation phase must read the relevant locally installed guidance under `node_modules/next/dist/docs/`, as required by `AGENTS.md`, and record the consulted convention.

### Candidate Detection and Corroboration Pipeline

Each stage adds evidence; no stage independently grants deletion.

1. **Establish immutable baseline**
   - Record commit/worktree state, Node/npm versions, lockfile identity, and environment availability without secret values.
   - Run `npm ci` when dependencies are absent, then `npm run lint`, `npx tsc --noEmit`, and `npm run build`.
   - Run the audit-only TypeScript unused probe without changing `tsconfig.json`.
   - Preserve complete command, exit code, summary, and timestamp. Separate existing failures from new wave regressions.

2. **Build the element and entry-point inventory**
   - Enumerate all tracked files and classify code, framework entry point, script, config, asset, SQL, documentation, generated declaration, or external-contract descriptor.
   - Parse TypeScript/TSX/MJS with the installed TypeScript/compiler tooling to list imports, exports, declarations, references, type-only edges, JSX components, callbacks, and module side effects.
   - Treat every `package.json` script, Next.js convention file, SQL file referenced by upgrade instructions, and public URL as an entry point even when it has no import edge.

3. **Surface local unused candidates**
   - Use ESLint `@typescript-eslint/no-unused-vars` and the audit-only `noUnusedLocals`/`noUnusedParameters` probe.
   - Classify imports, locals, parameters, private helpers, types/interfaces, and components separately. A deliberately required callback signature or side-effect import must be preserved even if its binding is unread.
   - Do not modify lint or TypeScript configuration to create a passing result.

4. **Construct repository-wide reference and dependency evidence**
   - Search symbol names, imported paths, aliases (`@/*`), file basenames, export names, string literals, route strings, asset paths, SQL object names, environment names, and package-script paths.
   - Record inbound and outbound edges and inspect the full dependency closure. Barrel exports, type-only consumers, re-exports, JSX references, callbacks, tests, documentation commands, and release packaging count.
   - Compare same-named root and `src/` files semantically; do not infer that the root copy is dead merely because active routes import the `src/` copy.

5. **Apply Next.js convention review**
   - Protect route and convention exports discovered without ordinary callers: `page.tsx`, `layout.tsx`, `route.ts` (`GET`, `POST`, `PATCH`, `DELETE`), `manifest.ts`, `proxy.ts`, `config.matcher`, metadata/viewport exports, `dynamic = 'force-dynamic'`, global CSS, favicon, and `public/` assets.
   - Compare the pre/post build route manifests exactly. The observed baseline route list is the minimum preserved set.
   - Review client/server boundaries and ensure a removal cannot move server-only code or secrets into a browser bundle.

6. **Review dynamic, side-effect, configuration, and operational use**
   - Search dynamic `import`, lazy loading, computed property access, registries, IDs, route strings, event names, callbacks, CSS class/selectors, global declarations, and side-effect-only imports.
   - Review `src/platform/module-registry.ts`, where module IDs, roles, status, and route strings are consumed by `OperationsDock` and `ToolsHub` rather than by direct imports of each route.
   - Review `package.json` scripts, CLI flags, `.npmrc`, deployment instructions, private bootstrap file paths, upgrade steps, migration ordering, and manual SQL procedures.
   - Absence of dynamic-import syntax does not remove the need to inspect registries, route strings, fetch URLs, Supabase object names, and externally invoked scripts.

7. **Review Supabase, auth, API, and data contracts as high risk**
   - Map browser, server, and proxy clients; cookie reads/writes; `auth.getClaims`, sign-in/password flows; manager authorization; and server-only admin-client creation.
   - Preserve `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_AUTH_EMAIL_DOMAIN`, `SUPABASE_SECRET_KEY`, and the supported `SUPABASE_SERVICE_ROLE_KEY` fallback with the same public/server visibility and defaults.
   - Map API route methods and string consumers. `/api/admin/users` has active GET/POST/PATCH/DELETE callers and uses manager authorization plus the server secret; it is not removable based on import analysis.
   - Extract every `.from`, `.rpc`, `.channel`, `.storage`, and `.auth` contract and map it to schema/migration objects, RLS/policies, triggers, storage buckets, and workflows. Known examples include `profiles`, `renewal_records`, `renewal_contacts`, `renewal_events`, `ensure_daily_availability_reset`, bucket `renewal-contact-evidence`, and realtime channel `work-desk-live`.
   - Treat historical migrations as applied-state and upgrade-path records. A migration with no source import is not unused code.

8. **Classify confidence, risk, and disposition**
   - **High confidence**: all applicable checks completed, no consumer or side effect, dependency closure independently classified, and validation is available.
   - **Medium confidence**: repository evidence is negative but an external, operational, generated, or runtime consumer cannot be disproved.
   - **Low/Unknown confidence**: evidence is incomplete, contradictory, or validation is unavailable.
   - **Low risk**: local implementation detail with no I/O, public API, state transition, or side effect.
   - **Medium risk**: shared export/component/style/asset or code affecting a bounded user flow.
   - **High risk**: route, auth, authorization, API, data query/mutation, Supabase, environment, script, setup/admin, deployment, registry, or SQL behavior.
   - **Critical risk**: secret boundary, account administration, RLS/policy, migration history, destructive data operation, or recovery path.
   - Allowed dispositions are `propose in wave`, `preserve`, `manual review`, or `defer`. Only High-confidence candidates are eligible for a cleanup wave; High/Critical-risk candidates additionally require affirmative owner/production review.

9. **Produce exact evidence records**

Every finding must contain:

| Field | Required evidence |
|---|---|
| Identity | Stable finding ID, exact element name, kind, signature/export status |
| Location | Repository-relative path and line/column range; file hash or baseline commit |
| Discovery | Tool/command, exact rule or diagnostic, and relevant output |
| References | Local and repository-wide matches, including zero-result query/scope |
| Dependency closure | Inbound/outbound edges and associated branches, helpers, types, exports, styles, assets, tests, callbacks, and side effects |
| Convention/dynamic review | Applicable Next.js rule, route/build evidence, registry/string/computed lookup results |
| Config/env/script/ops review | Package scripts, config consumers, env names/visibility/fallbacks, docs, migrations, deployment or external invocation |
| Integration review | Auth/API/Supabase tables, RPCs, storage, realtime, permissions, and data contracts affected |
| Classification | Confidence with rationale; production risk with impact rationale |
| Disposition | Preserve/review/defer/proposed wave and required approver |
| Validation | Available pre-checks, planned post-checks, unavailable checks and consequences |
| Rollback | Exact isolated patch/commit boundary and restoration check |

### Examples

- **Lint-proven local imports**: `AlertTriangle` (4:3), `CircleDollarSign` (8:3), and `FileClock` (13:3) in `src/features/renewals/RenewalsPage.tsx` are reported by both ESLint and the audit-only TypeScript probe. Expected audit behavior is to verify zero JSX/value/type use and no import-side-effect requirement before proposing only the unused specifiers. Actual pre-audit behavior retains them. These are candidate examples, not pre-authorized deletions.
- **Related-code closure**: `onClose` at `src/features/renewals/RenewalsPage.tsx:479:3` is an unread `RenewalDrawer` parameter, while a nearby wrapper uses its own `onClose`. Expected audit behavior is to trace every `RenewalDrawer` caller, prop type, callback creation, close behavior, and drawer interaction before proposing removal of the prop pair. Removing only the parameter could leave orphaned caller code.
- **Potential duplicate/orphan files**: tracked top-level `CsIntakeLanding.tsx`, `IntakeQueue.tsx`, and `work-desk-app.tsx` coexist with active modules under `src/`. Active App Router and workspace imports resolve to `src/features/...` and `src/components/work-desk-app.tsx`, and the build route manifest does not name the root files. Expected audit behavior is still to review package/release/manual consumers and semantic differences before assigning confidence; zero route imports alone is insufficient.
- **Framework edge case**: `src/proxy.ts` has no ordinary application caller but exports the framework `proxy` function and `config.matcher`; the build reports `Proxy (Middleware)`. Expected behavior is preservation.
- **Environment edge case**: `SUPABASE_SERVICE_ROLE_KEY` is a documented legacy fallback used by the bootstrap script and admin API even though `.env.example` comments it rather than defining an active value. Expected behavior is preservation of name, precedence, and server-only handling.
- **Operational edge case**: an old SQL migration may have no current TypeScript reference but remains necessary to understand and upgrade an installed database. Expected behavior is high-risk preservation unless an explicit migration-retention policy and production-state proof authorize archival.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- All elements with verified or uncertain consumers remain present and behaviorally unchanged.
- All baseline routes, nested pages, the manifest, protected API methods, redirects, role gates, and proxy matcher/session-refresh behavior remain unchanged.
- Login, forced password change, setup fallback, manager-only user administration, logout/session behavior, and server-only secret boundaries remain unchanged.
- Supabase queries, RPCs, realtime refresh, storage upload, database mutations, permissions, error handling, and persistence contracts remain unchanged.
- The module registry continues to expose the same role-filtered routes and labels through the operations dock and tools hub.
- Package scripts, bootstrap flags, private input path, environment names, defaults, legacy fallback, migration ordering, verification procedures, and deployment instructions remain available.
- Global CSS, images/icons, metadata, public URLs, and side-effect initialization remain unchanged unless non-use is independently proven.
- Existing lint/type/build rules remain intact; no ignore, suppression, exclusion, or weakened compiler/lint setting may be used to hide findings.
- The audit/design phase makes no production-code deletion or behavioral edit.

**Scope:**
All `X` for which `isBugCondition` is false are outside cleanup scope. This includes:
- elements with any direct, type-level, route, registry, string, callback, side-effect, configuration, environment, script, integration, operational, or external consumer;
- elements with incomplete or unavailable validation;
- ambiguous exports and files whose external consumers cannot be disproved;
- framework and generated contracts;
- historical SQL and deployment artifacts without affirmative archival proof;
- high/critical-risk elements without explicit production review.

Behavioral preservation is evaluated for the current user workflows: login, password change, setup, administration, dashboard/rotations, customer-service intake, intake queue, renewals, workload, quote lifecycle, reports, exports, tool navigation, realtime/fallback refresh, and role-specific access.

## Hypothesized Root Cause

1. **Repeated patch and release copying**: Large same-purpose files exist both at repository root and under the active `src/` structure.
   - Patches may have been copied in as staging or handoff artifacts and later superseded without removing the earlier copy.
   - Historical upgrade documents name canonical `src/` files, but external release practices must still be reviewed.

2. **Unused checks are advisory rather than a clean gate**: Current strict TypeScript does not enable `noUnusedLocals` or `noUnusedParameters`, while ESLint reports unused values as warnings among unrelated React lint errors.
   - The normal type check passes despite four current unused declarations.
   - The failing lint baseline makes it easy for warnings to be overlooked and must be recorded rather than silently fixed or suppressed.

3. **Multiple non-import entry-point systems**: Next.js conventions, package scripts, SQL operations, public assets, and environment variables are consumed without conventional imports.
   - `proxy.ts`, `route.ts` methods, `manifest.ts`, migrations, and bootstrap scripts can appear unreferenced to a module-only scanner.
   - Registries and endpoint strings establish runtime connections not represented as symbol calls.

4. **Production integrations create hidden dependency edges**: Supabase table/RPC/storage/realtime names and auth cookie behavior connect application code to deployed state.
   - An apparently unused type, selector, field, env fallback, or helper may encode a database, permission, or deployment contract.
   - Server/client boundaries and secret visibility make incorrect cleanup particularly costly.

5. **Limited automated workflow coverage**: There is no test script in `package.json`; current runtime verification relies on build checks and documented production/manual checklists.
   - Static non-use evidence cannot alone demonstrate workflow preservation.
   - Missing automation requires explicit smoke-test evidence and lowers confidence when affected behavior cannot be exercised safely.

6. **Dependency closures are easy to split incorrectly**: An unused parameter may have callers and callback factories; an unused import may sit near active icon mappings; an orphan file may reference still-active integrations.
   - Symbol-by-symbol deletion without closure analysis can leave dead caller code or remove behavior beyond the proven condition.

## Correctness Properties

Property 1: Bug Condition - Evidence-Based Unused Element Classification

_For any_ repository element where the bug condition holds (`isBugCondition` returns true), the audit SHALL produce a complete evidence record, classify the element with High confidence, trace and independently prove its dependency closure unused, and place only that proven closure into a bounded reversible cleanup wave with pre/post validation and rollback instructions; no production deletion SHALL occur during the audit/design phase.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8**

Property 2: Preservation - Valid, Indirect, and Uncertain Contracts

_For any_ repository element where the bug condition does not hold (`isBugCondition` returns false), the audit and any later fixed repository SHALL preserve the original element or escalate it for review, and `F′` SHALL remain observably equivalent to `F` for routes, environment contracts, framework conventions, scripts, exports, side effects, integrations, permissions, data behavior, validation configuration, deployment behavior, and user workflows.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9**

## Fix Implementation

### Changes Required

No production file is changed in the audit/design phase. The later implementation must first produce the evidence-backed candidate report, then execute separately approved cleanup waves.

**Scope**: Whole repository, with candidate-specific production paths determined by the completed evidence report.

**Primary audit inputs**: `package.json`, `tsconfig.json`, `eslint.config.mjs`, Next.js convention files, `src/**`, top-level source-like files, `scripts/**`, `public/**`, `supabase/**`, `.env.example`, and operational documentation.

**Specific Changes:**

1. **Wave 0 — Inventory and report only**
   - Capture the complete tracked-file inventory and contract-only inputs.
   - Record exact baseline results and build route manifest.
   - Generate one evidence record per candidate, including preserved/review candidates, without editing production code.
   - Review report completeness and obtain disposition approval before any cleanup wave.

2. **Wave 1 — Low-risk local declarations/imports**
   - Scope only High-confidence, Low-risk local imports, locals, parameters, private helpers, or types.
   - Keep each logical closure independent. The three lint-reported icon imports may form one import-only wave after corroboration; `onClose` must be a separate closure because caller props and UI behavior are involved.
   - Run targeted file checks plus the full lint/type/build gates before and after.

3. **Wave 2 — Proven leaf exports/functions/types/styles/assets**
   - Include only elements with no inbound static/type/dynamic/convention edges and no side effects.
   - Confirm public assets against JSX, CSS, metadata, manifest, documentation, and direct URL contracts.
   - Do not combine unrelated features; use one bounded feature or dependency closure per wave.

4. **Wave 3 — Proven orphan files or duplicates**
   - Compare potential duplicates semantically and verify canonical imports, package scripts, release packaging, documentation, external/manual consumers, and build behavior.
   - Remove a file only when every declaration and side effect in that file is independently covered by the proof.
   - Root-level source-like files are candidates for this wave only after operational signoff; their location outside App Router is not sufficient proof.

5. **Wave 4 — High-risk contracts, normally preserve**
   - Routes, API/auth/session/Supabase/data/env/config/scripts/SQL/setup/admin/deployment candidates require affirmative owner review, production-state evidence, focused integration checks, and a dedicated wave.
   - Historical migrations, secret boundaries, RLS/policies, account administration, and recovery procedures default to preserve. Any approved archival or removal must not alter deployed database state and must have an independently rehearsed recovery path.

6. **Validation gates for every wave**
   - Pre-wave: cleanly identify the baseline commit/patch, candidate IDs, affected workflows, and expected unchanged route/env/integration contracts.
   - Post-wave: rerun `npm run lint`, `npx tsc --noEmit`, the audit-only unused probe, `npm run build`, targeted checks, and applicable smoke/integration tests.
   - Compare results diagnostically. The existing lint failure may remain pre-existing, but no new finding, changed route, weakened rule, or hidden exclusion is acceptable.
   - A check that cannot run must be recorded and prevents “fully validated” status.

7. **Reversibility and rollback**
   - Represent each wave as a small isolated patch or explicitly approved commit containing no unrelated formatting/refactor.
   - Record the exact files and candidate IDs in the boundary. Do not mix schema/data migrations with code cleanup.
   - On validation or runtime failure, revert only that wave, rerun its preservation gates, and verify the prior route manifest and workflows. Rollback must require no data repair or unrelated production change.

8. **No opportunistic refactor**
   - Do not rename APIs, consolidate active modules, alter component architecture, fix unrelated React lint errors, change dependencies, or update configs as part of unused-code waves.
   - Related cleanup is included only when its own non-use is proven and documented in the same dependency closure.

## Testing Strategy

### Validation Approach

Validation has two phases. First, exploratory checking runs on `F` to surface concrete counterexamples and establish the actual baseline. Second, each independently approved wave verifies fix checking for `C(X)` and preservation checking for `¬C(X)`. Static evidence, build evidence, and runtime/operational evidence are all required according to risk.

No current automated test script exists. Therefore the design distinguishes checks that can run now from manual or future automated checks and does not claim complete validation from lint/type/build alone. Development servers/watchers are not part of automated command execution; an authorized reviewer runs any required local smoke session manually using the documented command and non-production credentials/environment.

### Exploratory Bug Condition Checking

**Goal**: Surface retained elements that satisfy or may satisfy the bug condition before cleanup, and confirm or refute the root-cause hypotheses.

**Test Plan**:
1. Snapshot `git ls-files`, worktree state, package scripts, config, and environment names.
2. Run and record lint, strict type, audit-only unused, and production-build baselines.
3. Build the import/export/reference graph and candidate list.
4. For each candidate, perform framework, dynamic, side-effect, script, env, integration, SQL, documentation, and external-use review.
5. Capture counterexamples as evidence records; candidates with incomplete evidence remain preserved/review.

**Test Cases:**
1. **Unused import signal**: Verify the three `RenewalsPage.tsx` icon imports are reported and have no valid value/type/JSX or side-effect use.
2. **Unused parameter closure**: Verify the `RenewalDrawer.onClose` parameter finding and trace every caller and close callback before deciding its complete removable closure.
3. **Potential root duplicate**: Verify active imports resolve to canonical `src/` modules, compare root files, and search scripts/docs/external release procedures before classification.
4. **Framework false positive**: Present `src/proxy.ts`, `manifest.ts`, a `page.tsx`, and API `route.ts` as sparse-reference candidates and verify convention/build evidence forces preservation.
5. **Dynamic registry false positive**: Present a module route or metadata field with no direct symbol caller and verify `appModules` consumption by role-filtered navigation forces preservation.
6. **Environment fallback edge case**: Verify `SUPABASE_SERVICE_ROLE_KEY` remains protected because it is a server-only fallback in both bootstrap and admin API paths.
7. **Operational SQL edge case**: Verify an old migration remains protected by upgrade/applied-state semantics even without a TypeScript reference.

**Expected Counterexamples:**
- Four exact unused declarations are already surfaced by two independent static checks.
- Top-level source-like files may be candidate orphan copies, but external/operational use is not yet disproved.
- Framework, environment, registry, endpoint-string, and migration examples demonstrate why ordinary import absence is insufficient.

If exploratory evidence refutes a hypothesized root cause, update the evidence model and root-cause section before authorizing a cleanup wave.

### Fix Checking

**Goal**: For all `X` where `C(X)` holds, verify that the approved wave removes only the proven-unused closure and leaves no orphaned related code.

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  pre := captureRepositoryAndBehavior(F, X)
  decision := audit(X)
  ASSERT expectedBehavior(decision)

  F_prime := applyApprovedWave(F, decision.dependencyClosure)
  ASSERT elementAbsent(F_prime, X)
  ASSERT noUnclassifiedOrphanRemains(F_prime, decision.dependencyClosure)
  ASSERT allWaveValidationGatesPassOrMatchRecordedBaseline(F_prime)
END FOR
```

Fix checking includes exact diff review, repeat reference analysis, targeted compile/lint, full type/build checks, route-manifest comparison, and candidate-specific behavior checks. A candidate is not fixed merely because a warning disappears.

### Preservation Checking

**Goal**: For all `X` where `C(X)` does not hold, verify equivalent behavior and contracts between `F` and `F′`.

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT disposition(X) IN {PRESERVE, MANUAL_REVIEW, DEFER}
  ASSERT observableContracts(F, X) = observableContracts(F_prime, X)
END FOR

ASSERT routeManifest(F) = routeManifest(F_prime)
ASSERT environmentContract(F) = environmentContract(F_prime)
ASSERT integrationContract(F) = integrationContract(F_prime)
ASSERT validationConfiguration(F) = validationConfiguration(F_prime)
```

**Testing Approach**: Property-based checking is recommended for the candidate classifier and dependency graph because it can generate combinations of direct, type-only, dynamic, framework, side-effect, and external consumers. Runtime workflow preservation uses deterministic integration/smoke scenarios because it depends on authorized Supabase state and role-specific accounts.

**Test Plan**:
- Snapshot and compare route manifest, HTTP method exports, proxy matcher, module registry, package scripts, env names/visibility/defaults/fallbacks, Supabase object names, and validation configs.
- Execute affected role/workflow checks before and after the wave using non-production or safely controlled data.
- Treat missing environment, unavailable credentials, absent test automation, or unsafe production operations as explicit validation gaps that block full approval.

**Test Cases:**
1. **Route preservation**: All observed build routes and proxy remain present with the same static/dynamic classification where relevant.
2. **Environment preservation**: Configured and missing-variable paths retain setup/error behavior; public values remain browser-eligible and secrets remain server-only; legacy fallback precedence is unchanged.
3. **Auth/role preservation**: Anonymous, inactive, forced-password-change, agent, customer-service, and manager paths retain redirects and permissions.
4. **Admin API preservation**: GET/POST/PATCH/DELETE retain authentication, manager authorization, status/error semantics, and secret handling.
5. **Supabase preservation**: Queries, mutations, RPCs, realtime subscription/fallback refresh, storage upload, RLS-sensitive behavior, and data ownership remain unchanged.
6. **Navigation/registry preservation**: Role-filtered modules and route strings continue to render and navigate identically.
7. **Operational preservation**: Bootstrap command/flags, migration sequence, verification SQL, deployment environment names, and recovery instructions remain intact.
8. **Validation preservation**: `tsconfig.json`, ESLint rules, Next config, package scripts, and include/exclude scopes do not change merely to hide findings.
9. **Rollback**: Reverting the isolated wave restores the prior known-good source and baseline behavior without database repair.

### Unit Tests

- Validate evidence-record schema completeness and reject a proposed-removal disposition when any required field is absent.
- Validate confidence/risk rules: any consumer or incomplete check makes `isBugCondition` false; High/Critical risk requires explicit review even with High confidence.
- Validate import/export/reference extraction for locals, parameters, types, re-exports, aliases, JSX, callbacks, string routes, and side-effect imports.
- Validate Next.js convention classification for pages, layouts, route HTTP methods, manifest, proxy, metadata, global CSS, and public assets.
- Validate dependency-closure traversal so caller props, branches, helpers, styles, exports, and tests are not silently orphaned.
- Validate environment classification without reading values and preserve public/server visibility, defaults, and fallback order.

### Property-Based Tests

- Generate element graphs with arbitrary consumer combinations and verify that any valid consumer implies `isBugCondition = false`.
- Generate complete no-consumer graphs and verify that only independently proven-unused closures can receive High-confidence proposed-cleanup status.
- Generate incomplete evidence records and verify they are always preserved/reviewed, never represented as fully validated.
- Generate dependency graphs with shared descendants and verify cleanup removes only nodes unreachable from every preserved entry point.
- Generate risk/category combinations and verify route/auth/API/data/env/script/SQL elements default to High/Critical risk and require affirmative review.
- Generate before/after contract snapshots and verify differences in routes, env names, scripts, registry entries, integration names, or validation rules fail preservation.

No property-test library is currently configured. Implementation should prefer the existing TypeScript runtime/toolchain and add a test dependency only through a separately reviewed, lockfile-pinned change. Until then, deterministic exhaustive fixtures must cover the classifier dimensions and the missing PBT automation must be reported.

### Integration Tests

- Compare pre/post `npm run build` route output for every page, nested page, API route, manifest, setup route, and proxy.
- Exercise login, logout/session refresh, forced password change, setup fallback, role-based tool access, and manager user administration.
- Exercise dashboard rotations, customer-service intake creation/editing, intake queue claim/assignment/conversion, renewals import/assignment/contact evidence, workload handling, quote lifecycle, reports/exports, and tool navigation according to existing checklists.
- Verify realtime updates, 60-second fallback, focus/tab return, and reconnection refresh behavior.
- Verify Supabase table/RPC/storage/realtime contracts and representative success, permission-denied, validation, missing-configuration, and session-expired paths.
- Verify bootstrap behavior in a safe environment, including secret fallback and reset flags, without exposing credentials or changing production accounts.
- For SQL/config candidates, use schema/verification checks and deployment-owner review; never run destructive migration or recovery operations against production as part of cleanup validation.
