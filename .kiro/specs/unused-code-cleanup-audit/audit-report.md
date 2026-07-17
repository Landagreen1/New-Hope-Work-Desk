# Whole-System Inventory and Bug-Condition Evidence Report

## Decision summary

Audit timestamp: `2026-07-15T23:29:40.9597196-04:00` through `2026-07-15T23:31:56.8401780-04:00`  
Baseline commit: `37589c72c5488a2daae07844ffcdc035527e1e3a`  
Repository state: unfixed; `git status --short` showed only the pre-existing untracked `.kiro/` tree. `git diff --name-only` contained no tracked change. This task changed only untracked spec evidence (`audit-report.md` and `audit-classifier.test.mjs`) and did not edit production source, configuration, dependencies, assets, SQL, or operational documents.

**Bug-condition exploration result: confirmed.** Four retained declarations satisfy the static and complete no-consumer shape of `C(X)`: `AlertTriangle`, `CircleDollarSign`, `FileClock`, and `RenewalDrawer.onClose` in `src/features/renewals/RenewalsPage.tsx`. The deterministic exploration test deliberately asserts that no such retained declaration exists and fails with those four concrete counterexamples. Under the bugfix exploration protocol, that expected failure is a successful exploration result; the PBT/exploration status was recorded as `passed` with the counterexample.

Disposition summary:

| Disposition | IDs | Audit approval |
|---|---|---|
| Propose in Wave 1A | UC-001, UC-002, UC-003 | Evidence-complete proposal approved by the audit policy; production removal still requires the separately sequenced cleanup task/reviewer. |
| Propose in Wave 1B | UC-004 and its exact caller/type closure | Evidence-complete proposal approved by the audit policy; production removal and targeted drawer smoke approval remain separate. |
| Manual review/defer | UC-005–UC-014 | Approved preservation disposition. No deletion is authorized without the named operational/external owner review. |
| Preserve | All framework, route, API/auth, Supabase/data, environment, registry, script, SQL, migration, configuration, generated, documented operational, and observed-consumer elements | Approved by default risk policy. |

No cleanup wave is authorized by this report alone. Root-file and public-URL candidates have unresolved external/operational consumers. High/Critical-risk contracts have no safe configured integration environment or owner production-state review and remain preserved.

## Immutable baseline

### Repository, runtime, lockfile, and installation

| Evidence | Observation |
|---|---|
| Baseline command | `git rev-parse HEAD; git status --short; git ls-files; node --version; npm --version; git hash-object package-lock.json; npm ls --depth=0 --json` |
| Timestamp | `2026-07-15T23:29:40.9597196-04:00` |
| Commit | `37589c72c5488a2daae07844ffcdc035527e1e3a` |
| Worktree | Only `?? .kiro/`; no tracked production diff. |
| Tracked inventory | 106 files from `git ls-files`. |
| Runtime | Node `v24.18.0`; npm `11.16.0`. |
| Lockfile identity | Git blob `8a716567c0a50566f055581a9035f339c178d0e7`. |
| Installed state | `npm ls --depth=0 --json` exited 0; direct installed versions were `@supabase/ssr 0.12.0`, `@supabase/supabase-js 2.110.1`, `clsx 2.1.1`, `lucide-react 1.23.0`, `next 16.2.10`, `react/react-dom 19.2.4`, `typescript 5.9.3`, `eslint 9.39.4`, `eslint-config-next 16.2.10`, Tailwind/PostCSS and type packages. No install or lockfile change was performed. |
| Environment handling | Only names, visibility, defaults, and fallback order were inventoried. No `.env.local` value or secret value was read or recorded. |

### Required command baseline

| Timestamp | Exact command | Exit | Diagnostic summary |
|---|---|---:|---|
| `2026-07-15T23:31:53.1098880-04:00` | `npm run lint` | 1 | Exact established baseline: 23 findings, 18 errors and 5 warnings. Four warnings are UC-001–UC-004; the other 19 React/Next diagnostics are pre-existing and unrelated. |
| `2026-07-15T23:31:53.1255578-04:00` | `npx tsc --noEmit` | 0 | Strict current TypeScript configuration passes. |
| `2026-07-15T23:31:53.1387334-04:00` | `npx tsc --noEmit --noUnusedLocals --noUnusedParameters --incremental false` | 2 | Expected discovery failure: exactly four TS6133 diagnostics at `RenewalsPage.tsx` 4:3, 8:3, 13:3, and 479:3. The preservation runner normalizes its shell status as nonzero; candidate identity/count is exact. |
| `2026-07-15T23:31:56.8401780-04:00` | `npm run build` | 0 | Next.js 16.2.10 production compilation, TypeScript, page-data collection, and static generation passed. |

No rule, include/exclude scope, suppression, dependency, or config was changed. There is no package `test` script.

### Normalized route/proxy oracle

| Marker | Contract | Source/exports |
|---|---|---|
| `ƒ` | `/` | `src/app/page.tsx` |
| `○` | `/_not-found` | framework generated |
| `ƒ` | `/api/admin/users` | `route.ts`; runtime `nodejs`; exports `GET`, `POST`, `PATCH`, `DELETE` |
| `ƒ` | `/change-password` | App Router page |
| `ƒ` | `/login` | App Router page |
| `○` | `/manifest.webmanifest` | `src/app/manifest.ts` |
| `○` | `/setup` | App Router page |
| `ƒ` | `/tools` | App Router page |
| `ƒ` | `/tools/cs-intake` | App Router page |
| `ƒ` | `/tools/cs-intake/queue` | App Router page |
| `ƒ` | `/tools/renewals` | App Router page |
| `ƒ` | `Proxy (Middleware)` | `src/proxy.ts`; named `proxy` export plus constant `config.matcher` |

## Exhaustive inventory boundary and classification

`git ls-files` is the authoritative maintained-file inventory. The source/config compilers additionally observe ignored `.next/` generated types and installed `node_modules/` tooling as evidence, never as cleanup subjects.

| Inventory class | Count / exact boundary | Classification |
|---|---|---|
| Application source | 42 tracked files under `src/**` | Every declaration/import/export/type/alias/re-export/JSX/callback/module side effect was covered by strict TypeScript, audit-only unused TypeScript, ESLint, import/path/reference review, and the contract oracle. Four local findings were produced. App convention files and verified graph members are preserved. |
| Root source-like | 3: `CsIntakeLanding.tsx`, `IntakeQueue.tsx`, `work-desk-app.tsx` | UC-005–UC-007; no App Router/import edge, but external/manual handoff use is unresolved, so manual review/defer. |
| Script | 1: `scripts/bootstrap-users.mjs` | Package entry point and private-input/CLI/env contract; High/Critical preserve. |
| Public assets | 10 | Active: icons and horizontal logo; seven zero-repository-reference URLs are UC-008–UC-014 and deferred for external URL review. |
| SQL | 18: schema, seed, 12 migrations, 2 versioned verification files, 2 root verification/readiness files | Applied-state, upgrade, RLS/policy/trigger, deployment and recovery contracts; High/Critical preserve. |
| Operational/docs | 23 Markdown/text files | Release, setup, deployment, upgrade, architecture, test, recovery and history consumers; preserve. |
| Config/runtime descriptors | `.env.example`, `.gitignore`, `.npmrc`, `eslint.config.mjs`, `next-env.d.ts`, `next.config.ts`, `package.json`, `package-lock.json`, `postcss.config.mjs`, `tsconfig.json` | Configuration/framework/generated/package contracts; preserve. |
| Generated/third-party evidence | `.next/**`, `node_modules/**` | Excluded subjects. Used for generated route/types/build evidence and local Next.js 16 guidance. |
| Contract-only runtime inputs | `.env.local` names and `private/bootstrap-users.json`, `private/PRIVATE-USER-CREDENTIALS.txt` paths | Files unavailable and not read. Names/paths only; preserve external contract. |

Tracked application/source inventory: all `src/app/**` pages, layout, manifest, CSS, favicon and admin route; all six `src/components/**`; all feature modules under `src/features/cs-intake`, `nhwd-shared`, `platform`, `renewals`, and `workload`; `src/lib/dashboard-data.ts`, Supabase browser/server/proxy clients, tool-session and shared types; `src/platform/module-registry.ts`; `src/proxy.ts`; the three root source-like files; and `scripts/bootstrap-users.mjs`.

Reference/dependency review included symbol names, resolved relative and `@/*` aliases, imports/re-exports/type-only bindings, file basenames, exports, JSX identifiers, callbacks, string and route literals, dynamic/computed selectors, CSS selectors/class strings, public URLs, environment names, package-script paths, API endpoint strings, Supabase table/RPC/channel/storage/auth names, SQL objects, and operational documentation. No dynamic `import()` candidate escaped classification. Presence-only framework, CSS, package, migration, and script entry points were treated as consumers.

### Local Next.js 16 convention evidence

The following installed files were read before classification:

- `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md`: `page.tsx` default exports make route segments publicly accessible.
- `.../layout.md`: the root layout is required, wraps route content, and owns root `<html>/<body>` plus metadata APIs.
- `.../route.md`: `route.ts` HTTP method exports are framework request handlers and route-segment config such as `runtime` is a contract.
- `.../proxy.md`: Next.js 16 renamed middleware to `proxy`; `src/proxy.ts`, named `proxy`, and constant `config.matcher` are convention-discovered and execute before routes.
- `.../public-folder.md`: every `public/` file is directly addressable from the base URL, so zero imports cannot prove non-use.
- `.../01-metadata/manifest.md`: `app/manifest.ts` is a special cached route handler producing `/manifest.webmanifest`.

Consequently all `page.tsx`, `layout.tsx`, `route.ts`, `manifest.ts`, `src/proxy.ts`, metadata/viewport exports, `dynamic = 'force-dynamic'`, global CSS, favicon, and active public URLs are preserved. The build oracle independently confirms the routes and proxy.

## High-risk contract review

### Environment, auth, API and client boundaries

Names only:

| Name | Visibility and consumers | Preserved order/default |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public; browser, server, proxy, admin API, bootstrap | Required where used; no value recorded. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public; browser, server, proxy | Required where used; no value recorded. |
| `NEXT_PUBLIC_AUTH_EMAIL_DOMAIN` | Public; login/admin/bootstrap identity mapping | Fallback remains `workdesk.newhope.local`. |
| `SUPABASE_SECRET_KEY` | Server-only; admin API/bootstrap | Preferred server secret. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only legacy fallback; admin API/bootstrap | Evaluated only after `SUPABASE_SECRET_KEY`. |

`src/lib/supabase/client.ts` creates the browser client and errors on missing public config. `server.ts` uses server cookies and tolerates Server Component write restrictions because proxy refreshes cookies. `src/proxy.ts -> updateSession -> createServerClient -> cookies.getAll/setAll -> auth.getClaims` is an active auth/session side-effect chain; matcher exclusions preserve static/image delivery. Home/tool guards preserve setup fallback, unauthenticated/inactive login redirects, forced password change, and role gates.

`/api/admin/users` is a dynamic Node route. Every GET/POST/PATCH/DELETE export is framework-consumed and active UI callers use the endpoint string. Each method first requires a valid session, active `profiles` row, and `manager` role, then creates a server-only admin client. Account creation, temporary-password reset, deactivation, last-manager/self/active-work protections and observed 400/401/403/404/409/503 semantics are High/Critical contracts. Preserve.

### Supabase/data/integration names

The exhaustive source extraction found these maintained table contracts: `audit_log`, `cs_intake_drivers`, `cs_intake_events`, `cs_intake_submissions`, `cs_intake_vehicles`, `daily_agent_performance`, `dealer_salespeople`, `dealers`, `pending_pricing_quotes`, `profiles`, `quote_notes`, `quote_outcomes`, `quote_take_events`, `quote_take_timers`, `renewal_assignment_aliases`, `renewal_contacts`, `renewal_events`, `renewal_import_runs`, `renewal_records`, `rotation_state`, `turn_events`, `user_notifications`, `work_desk_settings`, `work_item_events`, and `work_items`.

RPC contracts: `admin_deactivate_profile`, `complete_password_change`, `cs_intake_claim`, `cs_intake_convert`, `cs_intake_manager_assign`, `cs_intake_return`, `cs_intake_submit`, `ensure_daily_availability_reset`, `renewal_assign`, `renewal_delete_assignment_alias`, `renewal_generate_due_notifications`, `renewal_import_batch`, `renewal_manager_update`, `renewal_send_to_requote`, `renewal_update_contact_info`, `renewal_update_workflow`, `renewal_upsert_assignment_alias`, `send_quote_take_timer_warning`, `workload_log_list`, `workload_reassign`, and `workload_void`.

Storage bucket: `renewal-contact-evidence`. Realtime channels: `cs-intake-landing-v097`, `dealer-admin-live`, `renewals-v097`, `sales-intake-queue-v097`, `work-desk-live`, and `workload-management-log`. Auth methods include create/delete/list/get claims/get user/sign-in/sign-out/update operations. All `.from`, `.rpc`, `.channel`, `.storage`, and `.auth` contracts are preserved; runtime credentials and deployed state were unavailable, so none is represented as fully integration-validated.

### Registry, scripts, SQL, deployment and recovery

`src/platform/module-registry.ts` has five active IDs (`work-desk`, `operations-tools`, `cs-intake`, `cs-intake-queue`, `renewals`) with role-filtered labels/routes consumed by Operations Dock and Tools Hub. String-selected registry use is a valid consumer.

Package scripts `dev`, `build`, `start`, `lint`, and `bootstrap-users` are entry points. Bootstrap is invoked as `node --env-file=.env.local scripts/bootstrap-users.mjs`, supports `--reset-passwords` and `--reset-rotations`, reads the private JSON input path, documents a private credentials path, uses server-secret fallback and admin auth, and mutates profiles/dealers/rotations. It is Critical and preserved; it was not executed.

Database artifacts preserved in order:

- `supabase/schema.sql`, `supabase/seed-template.sql`.
- migrations `v0.3.0.sql`, `v0.4.0.sql`, `v0.5.0.sql`, `v0.6.0.sql`, `v0.7.0.sql`, `v0.7.2.sql`, `v0.7.3.sql`, `v0.7.4.sql`, `v0.8.0.sql`, `v0.9.3.sql`, `v0.9.7-integrated-cs-renewals.sql`, `v0.9.8-stabilize-integrations.sql`.
- verification `supabase/verification/v0.9.7-verification.sql`, `supabase/verification/v0.9.8-health-verification.sql`, plus root `v0.9.8-health-verification.sql` and `v0.9.9-install-readiness.sql`.

The SQL review found RLS enablement/policies and trigger contracts across schema/migrations, including profile/work-item/pending-pricing update triggers, turn/work-assignment notification triggers, authenticated policies, and renewal v0.9.7 policies. Migration non-import is not non-use: deployment directs new installs to schema, existing installations through ordered migrations, and upgrades through backups/read-only verification. Recovery preserves additive database objects. No SQL was run and no archival candidate is authorized.

## Evidence records

All records use baseline commit `37589c72c5488a2daae07844ffcdc035527e1e3a`. “Zero repository reference” means the exact binding/path query was run over maintained source, config, scripts, SQL, and operational documentation; same spelling in an unrelated scope is not a consumer of the binding.

### UC-001 — `AlertTriangle`

- **Identity:** named value import specifier from `lucide-react`; local, not exported. Signature `import { AlertTriangle } ...`.
- **Location/hash:** `src/features/renewals/RenewalsPage.tsx:4:3`; baseline Git blob `e42ed269044260dd62ba6b1dfc68638a3e2b24be`.
- **Discovery:** ESLint `@typescript-eslint/no-unused-vars` warning and TypeScript TS6133 from the audit-only probe.
- **References:** compiler-AST local count is one (its import declaration only); zero value/type/JSX/callback uses in this module. Repository spelling matches in other modules are distinct imports/bindings and not consumers.
- **Dependency closure:** only this named specifier. The same `lucide-react` import declaration retains many active specifiers, so removing this specifier neither suppresses module evaluation nor changes side effects. No branch/helper/type/style/asset/test/callback depends on it.
- **Convention/dynamic/config/env/script/ops/integration:** not convention-discovered, exported, string-selected, configured, environment-read, script-invoked, operationally named, or connected to API/Supabase/data.
- **Classification:** High confidence; Low production risk.
- **Disposition/approver:** `propose in wave` 1A with UC-002/003 import-only boundary; code-owner review required before execution.
- **Validation/gaps:** lint and unused probe independently agree; strict type/build pass. Runtime renewals smoke was not run, but the isolated unread import has complete static non-use evidence.
- **Rollback:** exact boundary is this one import specifier in one file. Restore the specifier at its prior sorted position and rerun lint diagnostic comparison, strict TypeScript, unused probe, build/route oracle, and renewals render/navigation check.

### UC-002 — `CircleDollarSign`

- **Identity:** named value import specifier from `lucide-react`; local, not exported.
- **Location/hash:** `src/features/renewals/RenewalsPage.tsx:8:3`; same baseline blob as UC-001.
- **Discovery:** ESLint unused warning plus TS6133.
- **References:** one AST identifier occurrence (declaration only); zero local value/type/JSX/callback uses. Other-file bindings of the same icon are independent and active.
- **Dependency closure:** this specifier only; active `lucide-react` import and mappings remain. No side effect or related closure.
- **Convention/dynamic/config/env/script/ops/integration:** all reviewed, none applicable/observed.
- **Classification:** High confidence; Low risk.
- **Disposition/approver:** propose Wave 1A; code owner.
- **Validation/gaps:** same gates and runtime gap as UC-001.
- **Rollback:** restore only this specifier, then run the full Wave 1A gates.

### UC-003 — `FileClock`

- **Identity:** named value import specifier from `lucide-react`; local, not exported.
- **Location/hash:** `src/features/renewals/RenewalsPage.tsx:13:3`; same baseline blob.
- **Discovery:** ESLint unused warning plus TS6133.
- **References:** one AST occurrence (declaration only); zero local value/type/JSX/callback uses and no repository consumer of this binding.
- **Dependency closure:** this specifier only; neighboring active `FileAudio`, `FileImage`, `FileText`, evidence rendering, and module import remain.
- **Convention/dynamic/config/env/script/ops/integration:** reviewed, no consumer/side effect.
- **Classification:** High confidence; Low risk.
- **Disposition/approver:** propose Wave 1A; code owner.
- **Validation/gaps:** same gates/gap as UC-001.
- **Rollback:** restore only this specifier and rerun full gates.

### UC-004 — `RenewalDrawer.onClose`

- **Identity:** destructured callback parameter and inline prop signature `onClose: () => void`; local `RenewalDrawer`, not exported.
- **Location/hash:** binding `src/features/renewals/RenewalsPage.tsx:479:3`, inline type at 486:3, sole JSX caller at 1532; same baseline blob.
- **Discovery:** ESLint unused warning plus TS6133 at 479:3. AST fixture confirms `onClose` occurs inside `RenewalDrawer` only in the destructuring binding and inline type, never in its body.
- **References/callers:** one `RenewalDrawer` declaration and one caller. The caller creates `onClose={() => setSelectedId(null)}` solely for this ignored prop. A separate outer `<Drawer ... onClose={() => setSelectedId(null)}>` at 1531 is active.
- **Dependency closure:** independently removable closure is exactly (1) destructured parameter, (2) inline prop type member, and (3) caller-side prop/callback at 1532. Removing only the parameter would leave orphan caller/type code. Preserve `Drawer.onClose`: it closes from backdrop mouse-down and the Close button; preserve selected state, all save/cancel/workflow actions, and the active outer callback. No Escape handler exists to alter.
- **Convention/dynamic/config/env/script/ops/integration:** component-local callback, not framework/export/config/script/ops selected. The drawer body has High-risk renewals integrations, but this unread callback has no edge to them.
- **Classification:** High confidence for non-use of the exact closure; Medium production risk because it is adjacent to UI close behavior.
- **Disposition/approver:** propose separate Wave 1B only; UI/code owner must approve and targeted drawer smoke must pass before execution.
- **Validation/gaps:** static checks agree; strict/build pass. Authorized drawer open, backdrop close, Close button, save/cancel, keyboard and error-path smoke is NOT RUN because no configured non-production environment/credentials were available. This gap blocks execution/full validation, not the audit finding.
- **Rollback:** one-file three-site closure only. Restore the binding, inline type member and caller prop together; rerun full gates and drawer behavior checks.

### UC-005 — root `CsIntakeLanding.tsx`

- **Identity:** tracked root source-like module exporting `RoleWorkspace`; despite its filename, semantic counterpart is active `src/components/role-workspace.tsx`, not the feature component.
- **Location/hash:** whole `CsIntakeLanding.tsx`; SHA-256 `e0f11be7cb5a23b33fe77643e3b72772f118278887d20cb4d58f9a25388cfbab`.
- **Discovery:** root/source duplicate review; absent from build routes and ordinary inbound imports.
- **References:** exact inbound import/path query outside the file and audit docs returned zero. Active `src/app/page.tsx` imports `@/components/role-workspace`. Package scripts do not name the root file. Historical docs name canonical `src/...` paths.
- **Dependency closure/semantic comparison:** diff against `src/components/role-workspace.tsx` is 17 lines (9 insertions/8 deletions). Root copy is older: canonical adds `PowerBiRenewalImport`, `WorkloadLog`, updated role/tab behavior and workspace props. The root file itself imports active feature modules and has client state, so every declaration/side effect would need owner confirmation before whole-file removal.
- **Convention/dynamic/config/env/script/ops/integration:** not an App Router convention. No registry/package/deployment import found, but plausible manual release/handoff/external copy consumption cannot be disproved. Its feature imports touch renewals/intake/workload contracts.
- **Classification:** Medium confidence of repository non-use; Medium/High impact if externally used.
- **Disposition/approver:** `manual review`/defer; possible Wave 3 only after operational/release owner signs off that root patch/handoff files are not consumed.
- **Validation/gaps:** build omission is insufficient; release packaging and external consumer inventory unavailable. No runtime smoke.
- **Rollback:** if later approved, one-file patch only; restore this exact SHA-256 file and rerun full route/build plus role workspace/intake/renewals/workload smoke.

### UC-006 — root `IntakeQueue.tsx`

- **Identity:** tracked root source-like legacy full Work Desk implementation; semantic counterpart is `src/components/work-desk-app.tsx`, not the small feature queue module.
- **Location/hash:** whole `IntakeQueue.tsx` (about 11,162 lines); SHA-256 `8a8a96e3936f34ed449164d8fa9fb081507be582ed468deb5b4b6a9fdafd3229`.
- **Discovery:** root duplicate review and zero active inbound import/route edge. Lint still scans it and reports one pre-existing React effect error, proving it remains in validation scope.
- **References:** no maintained source/package script imports the root path. Active home workspace consumes `src/components/work-desk-app.tsx`; docs/release commands consistently name canonical `src/components/work-desk-app.tsx`.
- **Dependency closure/semantic comparison:** diff against canonical is substantial (955 changed lines: 723 insertions/232 deletions), so it is an older divergent application snapshot, not a byte duplicate. It contains auth/API/realtime/data/reporting/admin behavior and module side effects; whole-file proof requires every declaration/edge and external handoff use to be disproved.
- **Convention/dynamic/config/env/script/ops/integration:** not framework-discovered, but it embeds `/api/admin/users`, `work-desk-live`, Supabase and operational functionality. External patch/manual consumer remains plausible.
- **Classification:** Medium confidence repository-orphan candidate; High/Critical consequence due embedded admin/auth/data behavior.
- **Disposition/approver:** manual review/defer; possible one-file Wave 3 only with release/operational owner and production-state review.
- **Validation/gaps:** external packaging, handoff and runtime consumers unavailable; no authorized workflow smoke.
- **Rollback:** one-file patch; restore exact SHA-256 and rerun lint fingerprint, strict/unused/build/routes and complete Work Desk/admin/realtime/report workflows.

### UC-007 — root `work-desk-app.tsx`

- **Identity:** tracked root source-like module exporting `dynamic = 'force-dynamic'` and default async `Home`; exact byte copy of `src/app/page.tsx`.
- **Location/hash:** whole root file; SHA-256 `4fd85f4b159e850aa7e485b497efb93b4cb557f95fef5c1cac25354ed6bedc93`; canonical hash is identical.
- **Discovery:** exact duplicate hash/diff and no ordinary inbound edge. The production route is sourced from `src/app/page.tsx`.
- **References:** exact root-path inbound query outside audit docs is zero; canonical alias imports are active. Package scripts and documented deploy/upgrade procedures do not name the root file.
- **Dependency closure:** entire file is a duplicate auth/home route implementation with server imports, redirects, profile query and role workspace. It has no independent module side effect, but every declaration is High-risk if an external handoff consumes this root artifact.
- **Convention/dynamic/config/env/script/ops/integration:** root filename is not the `app/page.tsx` convention, and build omission confirms no Next route. External/manual release use is still unresolved; its contents encode auth, `profiles`, setup/login/password redirects and server/client boundary.
- **Classification:** High repository-internal non-use evidence but only Medium overall confidence because external use cannot be disproved; High production risk.
- **Disposition/approver:** manual review/defer; one-file Wave 3 only after operational owner signoff.
- **Validation/gaps:** external consumer/release-owner evidence absent. Build omission alone is not approval.
- **Rollback:** restore exact file/hash and rerun full gates plus home auth/role smoke.

### UC-008–UC-014 — zero-repository-reference public URLs

Each is a tracked static asset served directly by Next.js from `/`, so zero imports do not establish `Consumers(X)=∅`. Query scope was all maintained TS/TSX/MJS/CSS/JSON/Markdown/text outside `public/` and audit artifacts. `icon-192.png`, `icon-512.png`, and `new-hope-logo-horizontal.png` have active metadata/manifest/UI consumers and are not candidates.

| ID | Identity/location/hash | Discovery/references | Closure and reviews | Classification/disposition/approver | Validation/rollback |
|---|---|---|---|---|---|
| UC-008 | `public/file.svg`; SHA-256 `2b67812c325c199a02536cdbeea0c593a72f707d323b72ee3e08dbab06753bd4` | zero repository URL/name result | single asset; public direct URL/external docs/bookmarks unresolved; no env/API/data edge | Medium confidence, Medium risk; manual review/defer; web/ops owner | No request-log/external inventory. One-file Wave 2 only; restore exact hash and verify URL/build. |
| UC-009 | `public/globe.svg`; `b614b9bf183925957661ac851498fe1d8029fd43a62fbfed86f9e2624a57e7cf` | zero result | same public/external review | Medium/Medium; manual review; web/ops owner | same boundary/gap |
| UC-010 | `public/new-hope-logo-vertical.png`; `9725c7ba0c8c40f0d163c6d7630284af7a244e0c16b363dec54008a47fc9c5d1` | zero result; horizontal logo is active but does not consume this file | brand asset may be externally linked or used in manual materials | Medium confidence, Medium/High brand risk; manual review; brand/web/ops owner | no external URL/CDN/log evidence; one file, restore hash |
| UC-011 | `public/new-hope-mark.png`; `a67d580715d36e0db84d653099e888a094846ccc3aaa040206bc4cd8b9541643` | zero result | brand/public URL external use unresolved | Medium, Medium/High; manual review; brand/web/ops owner | same boundary/gap |
| UC-012 | `public/next.svg`; `55995dfad6ecb4945a1e856ddca03c5e16aa5bf13fd21b4df6a74ae79357bcfc` | zero result | single framework-template asset but direct URL remains valid | Medium/Medium; manual review; web/ops owner | one file, restore hash and verify URL/build |
| UC-013 | `public/vercel.svg`; `f081337b2fee635b455b63275406a3e7f39d6a014e25ad90dab5a67e62a12ac4` | zero result | direct URL/external deployment material unresolved | Medium/Medium; manual review; web/ops owner | same boundary/gap |
| UC-014 | `public/window.svg`; `644768c4aaeb4767bce293344eeb0c125fb804a94d801440424072202d85e3a1` | zero result | direct URL/external consumer unresolved | Medium/Medium; manual review; web/ops owner | same boundary/gap |

## Deterministic classifier and exploration evidence

Artifact: `.kiro/specs/unused-code-cleanup-audit/audit-classifier.test.mjs`; existing Node `node:test` and installed TypeScript only. No dependency or lockfile change.

Command: `node --test ".kiro/specs/unused-code-cleanup-audit/audit-classifier.test.mjs"`.

- Passed exhaustive classification of all 2,048 combinations of 11 consumer classes: direct, type-only, dynamic, framework, side effect, configuration, environment, script, integration, operational, external. Only the complete no-consumer mask is a bug-condition shape.
- Passed incomplete, uncertain, required-side-effect, missing-consumer-class, external, non-repository and non-retained fixtures.
- Passed individual protection fixtures for every consumer class.
- Expected exploration failure: actual retained counterexample was `['AlertTriangle', 'CircleDollarSign', 'FileClock', 'RenewalDrawer.onClose']`, expected `[]`. Test summary: 4 tests, 3 ordinary passes, 1 expected bug-condition failure.

Exploration/PBT task status: **passed** because the failing assertion correctly detected the unfixed defect. Randomized PBT is **not configured**; no test library exists and no dependency was approved. Its absence is a validation gap, not a blocker for this deterministic audit.

## Validation gaps and approval boundary

- `.env.local`, private bootstrap input, authorized non-production credentials, role accounts, controlled records, and configured Supabase project were unavailable. No secret value was inspected.
- No browser/integration suite or package `test` script exists. `npm run dev` was not started. Auth/session, API methods, Supabase reads/writes/RPC/storage/realtime, role navigation, scripts, and SQL were not executed.
- No bootstrap reset, migration, account mutation, destructive SQL, recovery or production operation was attempted.
- Root source-like files require explicit release/operational-owner signoff before any Wave 3 action. Public asset URLs require web/operations (and brand where applicable) review before any Wave 2 action.
- High/Critical contracts remain preserved and cannot be called fully validated without safe integration evidence and affirmative production-state review.
- UC-001–UC-004 are evidence-complete cleanup proposals, not production edits. Their separate wave approvals, pre/post preservation gates, targeted smoke evidence and rollback execution belong to Task 3.

**Task 1 conclusion:** every requested inventory class and evidence-record field has been covered; candidate dispositions are documented and approved under the spec’s conservative policy. The unfixed repository retains four proven-unused declaration counterexamples, confirming the bug condition. No production change was made.

## Wave 1B execution — UC-004 `RenewalDrawer.onClose`

**Task:** 3.2. **Baseline commit:** `37589c72c5488a2daae07844ffcdc035527e1e3a`. **Boundary:** one tracked production file, `src/features/renewals/RenewalsPage.tsx`; no dependency, configuration, route, environment, SQL/schema/data, asset, or operational change. The pre-existing untracked `.kiro/` spec tree remained outside the production patch.

### Reconfirmed evidence and classification

- Repository/source search found one unexported `RenewalDrawer` declaration and one JSX caller. Its former `onClose` occurred only in the destructured binding and inline prop type; no body, type-only, callback, JSX, dynamic/string-selected, framework, configuration, script, operational, integration, or external consumer was found.
- The caller-side `onClose={() => setSelectedId(null)}` existed only to satisfy that ignored local prop. It was distinct from the preserved outer `Drawer` callback.
- The exact independently proven closure removed was: (1) `RenewalDrawer`'s destructured `onClose` parameter, (2) its inline `onClose: () => void` prop member, and (3) the sole caller-side ignored prop/lambda.
- `Drawer.onClose` was preserved. It remains consumed by backdrop `onMouseDown` and the visible Close button `onClick`; the drawer panel still stops mouse-down propagation. `selectedId` remains the open/close state, row/priority actions still open the selected renewal, and the outer callback still clears that state. Source and repository search found no Escape/keydown handler in the pre-wave drawer, so no keyboard behavior was removed or added.
- Assignment, contact/evidence, follow-up, manager edit/save, final renewed/lost/cancelled workflow, re-quote, refresh, history, and evidence download wiring remain in the unchanged `RenewalDrawer` body. The removed callback had no edge to those API/Supabase/data operations.
- **Classification:** `isBugCondition(input) = true` for the exact three-site closure; High confidence, Medium adjacency risk. Post-wave repository search shows no `RenewalDrawer.onClose` prop or callback orphan. Other components' active `onClose` contracts were preserved.

### Validation outcomes

| Gate | Outcome |
|---|---|
| `npm run lint` | Exit 1, established pre-existing failure shape: 18 errors and 5 warnings. The UC-004 `onClose` warning disappeared and no new production-source diagnostic appeared. The total warning count did not decrease because the pre-existing untracked `.kiro/specs/unused-code-cleanup-audit/audit-classifier.test.mjs:64:27` warning is included by the current workspace lint scan; it is outside this production wave. Unrelated React/Next diagnostics remain unchanged and were not fixed or suppressed. |
| `npx tsc --noEmit` | Exit 0. |
| `npx tsc --noEmit --noUnusedLocals --noUnusedParameters --incremental false` | Exit 2 as the expected discovery signal; exactly three TS6133 findings remain, all separate Wave 1A icon candidates (`AlertTriangle` 4:3, `CircleDollarSign` 8:3, `FileClock` 13:3). UC-004 disappeared and no new finding was introduced. |
| `npm run build` | Exit 0; Next.js 16.2.10 compiled, type-checked, collected page data, and generated static pages. |
| Route/proxy comparison | Exact: `ƒ /`, `○ /_not-found`, `ƒ /api/admin/users`, `ƒ /change-password`, `ƒ /login`, `○ /manifest.webmanifest`, `○ /setup`, `ƒ /tools`, `ƒ /tools/cs-intake`, `ƒ /tools/cs-intake/queue`, `ƒ /tools/renewals`, and `ƒ Proxy (Middleware)`. |
| `node .../preservation-oracle.mjs --compare` | Exit 0; exact pre-cleanup contract digest match. |
| `node --test .../preservation-oracle.test.mjs` | Exit 0; 6/6 deterministic preservation fixtures passed, including all 2,047 non-empty consumer combinations and exact contract equality. Randomized PBT remains not configured. |
| `git diff --check` | Exit 0. Repository search confirms the post-wave closure and preserved outer close contract. |
| Targeted source-contract smoke | Static trace passed for one declaration/one caller, absence of the ignored prop, preserved backdrop/Close-button callbacks, inner propagation stop, selected-state open/close path, and unchanged assignment/contact-evidence/save/cancel/workflow symbols. A follow-up inline AST command did not complete because the command session timed out after replaying lengthy gate output; no result from that incomplete command is claimed. |

### Runtime smoke gaps

Drawer open, backdrop close, Close-button close, browser keyboard behavior, unsaved-input cancel/reopen, save, assignment, contact evidence upload/download, final cancelled/renewed/lost transitions, re-quote, realtime, and full renewals workflow were **NOT RUN in a browser**. This workspace has no package browser/integration test script, configured non-production Supabase environment, authorized role credentials, controlled renewal records, or safe evidence-storage fixture. Per the observation-first policy, automation did not start `npm run dev` and did not mutate production or execute SQL/bootstrap operations. Source tracing plus strict compilation/build establishes the bounded non-use removal, but this wave is not represented as fully runtime validated; an authorized reviewer must complete those manual checks in a safe environment.

### Rollback boundary

Rollback is the inverse of this one-file, three-site closure only: restore `onClose` in the `RenewalDrawer` destructuring, restore `onClose: () => void` in its inline prop type, and restore `onClose={() => setSelectedId(null)}` on the sole `RenewalDrawer` caller. Do not restore or alter the separate outer `Drawer.onClose`. Then rerun strict TypeScript, the unused probe (UC-004 should return), production build/route comparison, contract oracle, and the drawer smoke checklist. Rollback requires no data repair, schema migration, secret rotation, or unrelated production change.

**Wave result:** the exact proven-unused UC-004 dependency closure was removed with no compile, build, route, proxy, contract-oracle, or static dependency regression. Implementation succeeded as a bounded reversible cleanup; full browser/runtime acceptance remains pending the explicitly unavailable authorized smoke environment.

## Wave 2 execution decision — no approved candidate patch (Task 3.3)

**Decision:** no production patch was authorized or applied. The complete candidate inventory contains no approved leaf export, function, type, style, or asset closure for Wave 2. Applying `isBugCondition(input)` independently to every possible Wave 2 record leaves the eligible set empty, so `expectedBehavior(result)` is satisfied by preserving the candidates rather than manufacturing a removal.

### Candidates considered and disposition

- **UC-008–UC-014** (`public/file.svg`, `globe.svg`, `new-hope-logo-vertical.png`, `new-hope-mark.png`, `next.svg`, `vercel.svg`, and `window.svg`) remain `manual review`/`defer`. Repository searches reconfirmed no JSX, CSS, metadata, manifest, documentation, filename, or runtime-generated path reference to these exact files outside audit evidence. The installed Next.js 16 `public-folder.md` guidance was reread and confirms that each file is nevertheless directly served at its base URL. Request logs, external-link inventories, release/CDN consumers, and web/operations approval remain unavailable; the two brand assets additionally lack brand-owner approval. Therefore evidence does not cover/disprove the external consumer class, confidence remains Medium, `isBugCondition(input) = false`, and no asset may be removed.
- No leaf export, function, or type was proposed by the approved task-1 inventory. The post-Wave-1B audit-only TypeScript probe reports only the three separate Wave 1A icon import candidates; it reports no Wave 2 declaration. Those icon imports remain outside Task 3.3's scope and were not changed here.
- No style candidate was approved. `src/app/globals.css` remains a framework side-effect import/contract, its variables and element rules remain active, and its only named selector, `.field`, has verified JSX consumers in the canonical `src/components/work-desk-app.tsx` (as well as the deferred root snapshot). Tailwind/runtime class usage and registry/dynamic searches produced no independently proven-unused style closure.
- Active manifest icons (`/icon-192.png`, `/icon-512.png`) and the active horizontal logo were not candidates and remain preserved.

### Validation and behavior evidence

| Gate/check | Task 3.3 result |
|---|---|
| Candidate references and closure | Exact asset-name/URL searches across TS/TSX/JS/MJS/CSS/JSON/Markdown/text found no repository consumer outside audit evidence; generic asset, metadata, manifest, CSS `url(...)`, selector, dynamic import, computed path, registry, and runtime-name searches found no hidden candidate closure. Direct public URLs and unresolved external consumers prevent approval. |
| `npm run lint` | Exit 1 with the current documented post-Wave-1B shape: 23 findings (18 errors, 5 warnings). The warnings are the three separate Wave 1A icon imports, the pre-existing `<img>` warning, and the untracked audit-fixture warning. No Task 3.3 diagnostic changed because no production patch was made. Machine-normalized fingerprint: `738c8e9eabe8bc2477f640bee2e885db41b73d781fe59bac1e33fa2963de91b5`. |
| `npx tsc --noEmit` | Final serialized run exited 0. An initial parallel run raced `next build` while `.next/types` was being regenerated and transiently reported missing generated `./routes.js`; the successful build completed generation, and the required serial rerun passed. |
| Audit-only unused probe | Exit 2 with exactly three TS6133 findings: `AlertTriangle` 4:3, `CircleDollarSign` 8:3, and `FileClock` 13:3 in `RenewalsPage.tsx`. No new finding and no Wave 2 finding. |
| `npm run build` and route/proxy oracle | Exit 0. Exact routes/classifications remain `ƒ /`, `○ /_not-found`, `ƒ /api/admin/users`, `ƒ /change-password`, `ƒ /login`, `○ /manifest.webmanifest`, `○ /setup`, `ƒ /tools`, `ƒ /tools/cs-intake`, `ƒ /tools/cs-intake/queue`, `ƒ /tools/renewals`, and `ƒ Proxy (Middleware)`. |
| Contract oracle and deterministic preservation fixtures | `preservation-oracle.mjs --compare` passed exactly, including all public asset hashes/URLs. `preservation-oracle.test.mjs` passed 6/6, including all 2,047 non-empty consumer combinations. Randomized PBT remains not configured. |
| Diff/config review | `git diff --check` passed. Task 3.3 changed no production source, public asset, style, dependency, config, environment contract, route, registry, SQL/schema/data, or operational procedure. The existing Wave 1B diff in `RenewalsPage.tsx` was preserved unchanged. |
| Candidate-specific runtime checks | No asset request-log/external-link environment or owner signoff was available. Per policy, this gap prevents approval rather than permitting deletion. No browser workflow changed, so no new workflow smoke was started and no production data/credentials were used. |

### Boundary and rollback

The Task 3.3 production boundary is empty: **zero files removed or modified and zero candidates moved to `removed`**. The only Task 3.3 artifact change is this appended audit decision in the untracked spec report. There is no production rollback action, data repair, schema migration, secret rotation, cache invalidation, or public-URL restoration to perform. If this evidence note itself must be reverted, remove only this `Wave 2 execution decision` section; do not alter the pre-existing Wave 1B production diff or any preserved asset.

**Task 3.3 result:** succeeded as an evidence-based no-op/defer outcome. All verified and uncertain consumers were preserved. A future one-asset patch is permissible only after the applicable web/operations/brand owner supplies affirmative external-use evidence and approval, after which that single asset must receive its own pre/post full gates, direct-URL check, and hash-based rollback boundary.
## Wave 3 execution decision — no operationally approved root-file patch (Task 3.4)

**Decision timestamp:** `2026-07-16T00:16:24.2490152-04:00`. **Decision:** no root source-like file was deleted or modified. UC-005–UC-007 remain `manual review`/`defer` because explicit operational/release-owner signoff is absent and plausible external/manual package consumers cannot be disproved. Accordingly, complete evidence does not cover the external/operational consumer class, `isBugCondition(input)` is false for each whole-file candidate, and the required one-file cleanup patches were not authorized.

### Reconfirmed candidate evidence and approval status

| Candidate | Semantic and canonical-import evidence | Operational/external review | Task 3.4 disposition |
|---|---|---|---|
| UC-005 root `CsIntakeLanding.tsx` | The root module is an older `RoleWorkspace` snapshot, not the canonical feature component its filename suggests. Diff against `src/components/role-workspace.tsx` remains 17 changed lines (9 insertions/8 deletions). Canonical code adds `PowerBiRenewalImport`, `WorkloadLog`, changed role/tab behavior, and a workload workspace prop. Active `src/app/page.tsx` imports `@/components/role-workspace`; active workspaces import `@/components/work-desk-app`, `@/features/cs-intake/CsIntakeLanding`, and `@/features/cs-intake/IntakeQueue`. No extensionless relative or dynamic import of the root path was found. | Package scripts do not name the file and documented replacement paths use canonical `src/` locations. However, the repository is distributed as a drop-in ZIP/current-project handoff and deployment guidance operates on the whole repository; no package manifest, external-consumer inventory, release-owner statement, or operational signoff proves the root artifact is not manually consumed. | Preserve/defer. Approval: **absent**. External/manual use: **unresolved**. |
| UC-006 root `IntakeQueue.tsx` | This is a divergent legacy full Work Desk snapshot, not the canonical small intake-queue feature. Diff against `src/components/work-desk-app.tsx` remains 955 changed lines (723 insertions/232 deletions). It contains many declarations plus auth/admin API, Supabase data, realtime, reporting, export, and UI side-effect behavior. Active home/workspace paths resolve to canonical `src/components/work-desk-app.tsx`; the queue route resolves to `src/features/cs-intake/IntakeQueue`. No extensionless relative or dynamic root import was found. | Release/upgrade docs found during review identify `src/components/work-desk-app.tsx` as the replacement path, but whole-repository ZIP/Git/Vercel and possible manual patch consumers remain unenumerated. Its High/Critical embedded contracts make repository import absence insufficient. No release/operations or production-state approval exists. | Preserve/defer. Approval: **absent**. External/manual use: **unresolved**. |
| UC-007 root `work-desk-app.tsx` | It remains byte-equivalent to canonical `src/app/page.tsx` (`git diff --no-index --quiet` exit 0) and carries the same server-side auth/profile/redirect/data-load behavior. The production route is convention-discovered only from `src/app/page.tsx`, which imports canonical `@/components/role-workspace`; no source, package-script, extensionless relative, or dynamic root import was found. | Root location is not a Next.js route convention, but exact duplication and build omission do not disprove a manually copied release/handoff contract. Whole-project packaging guidance and absent external inventory leave that class unresolved. No operational-owner signoff exists. | Preserve/defer. Approval: **absent**. External/manual use: **unresolved**. |

Repository reference analysis covered exact filenames (with and without extensions), relative/dynamic imports, canonical aliases, source declarations, package scripts, and maintained release/deployment documentation. `package.json` exposes only `dev`, `build`, `start`, `lint`, and `bootstrap-users` and names none of the candidates. `README-FIRST.md` describes a drop-in ZIP package; `README-FIRST.txt` and reviewed upgrade instructions name canonical `src/components/work-desk-app.tsx`; `LIVE-DEPLOYMENT-GUIDE.md` deploys the Git repository through Vercel. These observations support canonical repository use but do not provide the affirmative external/manual non-use proof or named owner approval required by this task.

### Validation and preservation results

No per-file post-delete gate exists because no file patch was authorized. A full no-op preservation run was nevertheless completed from the current prior-wave workspace:

| Gate/check | Result |
|---|---|
| `npm run lint` | Exit 1 with the established current baseline: 23 findings (18 errors, 5 warnings). Root `IntakeQueue.tsx:1083` retains its pre-existing React effect error; no Task 3.4 diagnostic changed. |
| `npx tsc --noEmit` | Exit 0. |
| `npx tsc --noEmit --noUnusedLocals --noUnusedParameters --incremental false` | Exit 2 with exactly three TS6133 findings, all separate retained Wave 1A icon candidates in `RenewalsPage.tsx` (`AlertTriangle` 4:3, `CircleDollarSign` 8:3, `FileClock` 13:3). No root-file declaration was reclassified by this probe. |
| `npm run build` | Exit 0 under Next.js 16.2.10. |
| Exact route/proxy comparison | Exact baseline match: `ƒ /`, `○ /_not-found`, `ƒ /api/admin/users`, `ƒ /change-password`, `ƒ /login`, `○ /manifest.webmanifest`, `○ /setup`, `ƒ /tools`, `ƒ /tools/cs-intake`, `ƒ /tools/cs-intake/queue`, `ƒ /tools/renewals`, and `ƒ Proxy (Middleware)`. |
| `node .kiro/specs/unused-code-cleanup-audit/preservation-oracle.mjs --compare` | Exit 0; exact pre-cleanup contract digest match. |
| `node --test .kiro/specs/unused-code-cleanup-audit/preservation-oracle.test.mjs` | Exit 0; 6/6 deterministic preservation fixtures passed, including every non-empty consumer combination and exact contract equality. Randomized PBT remains not configured. |
| Diff/config review | `git diff --check` exited 0. Task 3.4 made no tracked production/config/dependency/route/env/SQL/asset/operational change. The only tracked diff remains the pre-existing prior-wave `src/features/renewals/RenewalsPage.tsx` change; `.kiro/` remains untracked evidence. |

### Smoke gaps, patch boundary, and rollback

CS intake create/edit/submit, queue claim/assign/return/convert, Work Desk auth/role/dashboard/quotes/reports/exports, admin API, Supabase reads/writes/RPC/realtime, and release-package/manual-handoff smoke checks were **NOT RUN**. The workspace still has no configured safe non-production Supabase environment, authorized role credentials, controlled records, browser/integration test script, external package-consumer inventory, or named operational reviewer. Automation did not start `npm run dev`, mutate accounts/data, run bootstrap, or execute SQL. These gaps affect candidate confidence and therefore require preservation; this result is not represented as full runtime or operational validation.

The Task 3.4 production patch boundary is empty: zero candidate files removed and zero production files changed. There is no production rollback action. If a future owner affirmatively approves a candidate, it must remain a separate one-file patch with the recorded restoration boundary: UC-005 restore SHA-256 `e0f11be7cb5a23b33fe77643e3b72772f118278887d20cb4d58f9a25388cfbab`; UC-006 restore `8a8a96e3936f34ed449164d8fa9fb081507be582ed468deb5b4b6a9fdafd3229`; UC-007 restore `4fd85f4b159e850aa7e485b497efb93b4cb557f95fef5c1cac25354ed6bedc93`. Each future patch requires its own full gates, exact route/proxy comparison, affected workflow and release/handoff smoke evidence, and rollback verification. No inseparable closure was identified.

**Task 3.4 result:** completed as an evidence-based no-op/defer outcome. Canonical `src/` modules, routes, release behavior, manual/external contracts, and affected workflows were preserved because required operational approval and external non-use proof are absent.
## Wave 4 high-risk contract review — preserve by default (Task 3.5)

**Review window:** `2026-07-16T00:19:50.0648706-04:00` through `2026-07-16T00:20:23.3000147-04:00`. **Decision:** no high-risk cleanup patch was authorized or applied. Every reviewed route/framework, auth/session/authorization, API, Supabase/data, environment/configuration, registry, script/bootstrap, setup/admin/deployment, SQL/migration/RLS/policy, and recovery element remains `preserve`, `manual review`, or `defer`. No candidate has complete external, operational, deployed-state, side-effect, and integration evidence together with affirmative owner/production-state approval, focused safe-environment checks, and an independently rehearsed recovery path. Therefore `isBugCondition(input)` is false for every Wave 4 subject, and proposing cleanup would fail the High/Critical-risk extension of `expectedBehavior(result)`.

### Contract dispositions and corroborating evidence

| Area | Re-review evidence | Risk and disposition |
|---|---|---|
| Routes and Next.js conventions | Installed Next.js 16 `proxy.md` and `route.md` were reread. `src/proxy.ts` is convention-discovered, exports named `proxy` plus constant `config.matcher`, and the build reports `Proxy (Middleware)`. App pages, manifest, and `/api/admin/users` remain in the exact build oracle. Route handlers expose active `GET`, `POST`, `PATCH`, and `DELETE` framework entry points. | High; **preserve**. Framework invocation and active route/string consumers disprove non-use. |
| Auth/session/authorization | `src/lib/supabase/{client,server,proxy}.ts`, `src/app/page.tsx`, and `src/lib/tool-session.ts` reconfirm public-config handling, cookie `getAll`/`setAll`, `auth.getClaims`, setup/login/inactive/forced-password redirects, and role gates. Proxy matcher exclusions preserve static/image delivery. | High/Critical; **preserve**. Required auth side effects and permission behavior exist; no credentialed role matrix was available. |
| Admin API/account operations | `/api/admin/users` has active canonical UI callers for GET/POST/PATCH/DELETE. Every method requires an authenticated active manager. The route preserves validation/status behavior, server-only admin creation, profile/audit writes, create-user compensation, password reset, self-deletion protection, ban/deactivation, and unban compensation on RPC failure. | Critical; **preserve**. Active consumers and account mutations make `Consumers(X)` and `RequiredSideEffect(X)` non-empty. No account operation was executed. |
| Environment/configuration/secret boundaries | Public clients still read `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; identity mapping retains `NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || workdesk.newhope.local`. Admin API and bootstrap retain `SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY`, in that preferred-then-legacy order. `.env.example`, setup, and deployment docs keep the secret server-only. No secret value was read or recorded. | Critical; **preserve**. Names, public/server visibility, default, and legacy precedence are deployed contracts. |
| Supabase/data/integrations | Source and the contract oracle retain the complete `.from`, `.rpc`, `.channel`, `.storage`, and `.auth` inventory. Reconfirmed examples include `profiles`, active admin/data tables, `renewal_records`, `renewal_contacts`, `renewal_events`, `ensure_daily_availability_reset`, private bucket `renewal-contact-evidence`, and realtime `work-desk-live`. | High/Critical; **preserve**. Static and integration consumers exist; deployed object state and safe credentialed behavior were unavailable. |
| Registry/navigation | `src/platform/module-registry.ts` still defines the five active module IDs, routes, roles, labels, descriptions, and statuses. `OperationsDock` and Tools Hub consume registry metadata through filtering/string-selected IDs and route links. | High; **preserve**. Dynamic registry consumption is an affirmative consumer, not dead metadata. |
| Package and bootstrap scripts | `package.json` retains `bootstrap-users: node --env-file=.env.local scripts/bootstrap-users.mjs`. The script retains private `bootstrap-users.json` input, private credential output contract, `--reset-passwords`, `--reset-rotations`, admin-auth calls, profile/dealer/rotation writes, and server-secret fallback order. Deployment documents retain the emergency-reset invocation. | Critical; **preserve**. Operational entry point and destructive-capable account/data side effects are active contracts. Script was not executed. |
| Setup/admin/deployment/recovery | `LIVE-DEPLOYMENT-GUIDE.md`, `SETUP-CHECKLIST.md`, `README-FIRST.md`, and architecture guidance retain new-install versus ordered-upgrade distinctions, backup prerequisites, Vercel secret handling, private credential boundaries, acceptance checks, and emergency reset restrictions. | High/Critical; **preserve**. External operational consumers and production state are not affirmatively inventoried; owner approval is absent. |
| SQL, migrations, RLS, policies, triggers, storage, grants, and verification | All schema, seed, 12 versioned migrations, versioned verification files, and root SQL artifacts remain present. The latest reviewed migrations are transactional, baseline-sensitive, and define/replace tables, columns, RPC signatures, RLS policies, triggers, private storage, grants, and data mutation behavior. `v0.9.8-health-verification.sql` contains read-only catalog checks plus a reset call inside `BEGIN/ROLLBACK`; root `v0.9.8-health-verification.sql` is operationally ambiguous because its contents are the stabilization migration despite its filename. `v0.9.9-install-readiness.sql` is a stateful migration, not a disposable readiness note. | Critical; **preserve**, with root SQL naming/role subject to **manual owner review** only. Migration history and applied-state evidence cannot be inferred from imports, and no archival policy, deployed-state proof, isolated database, or rehearsed restore exists. |

No code cleanup was mixed with schema/data work. No migration, SQL statement, bootstrap command, password reset, account create/delete/deactivate, storage operation, or production request was run. No dependency, config, environment name, route, registry entry, secret boundary, SQL history, deployment instruction, or recovery procedure changed.

### Full safe gates and applicable checks

| Check | Outcome |
|---|---|
| `node .kiro/specs/unused-code-cleanup-audit/preservation-oracle.mjs --compare` | Exit 0; exact pre-cleanup contract digest match. This statically covers routes/API methods, proxy, env names/visibility/fallbacks, registry, package/bootstrap contracts, Supabase names, SQL order/hashes, and deployment/recovery evidence without capturing secrets. |
| `node --test .kiro/specs/unused-code-cleanup-audit/preservation-oracle.test.mjs` | Exit 0; 6/6 deterministic preservation tests passed, including every non-empty consumer combination and exact contract equality. Randomized PBT remains not configured. |
| `npm run lint` | Exit 1 with the established current baseline: 23 findings (18 errors, 5 warnings). No Wave 4 production edit occurred and no diagnostic was introduced, removed, suppressed, or reclassified. |
| `npx tsc --noEmit` | Exit 0. |
| `npx tsc --noEmit --noUnusedLocals --noUnusedParameters --incremental false` | Exit 2 with exactly the three separate retained Wave 1A TS6133 icon findings in `RenewalsPage.tsx` (`AlertTriangle` 4:3, `CircleDollarSign` 8:3, `FileClock` 13:3). No Wave 4 finding appeared. |
| `npm run build` | Exit 0 under Next.js 16.2.10. |
| Route/proxy oracle | Exact: `ƒ /`, `○ /_not-found`, `ƒ /api/admin/users`, `ƒ /change-password`, `ƒ /login`, `○ /manifest.webmanifest`, `○ /setup`, `ƒ /tools`, `ƒ /tools/cs-intake`, `ƒ /tools/cs-intake/queue`, `ƒ /tools/renewals`, and `ƒ Proxy (Middleware)`. |
| Diff/config boundary | `git diff --check` exited 0. The only tracked diff remains the prior approved Wave 1B change in `src/features/renewals/RenewalsPage.tsx`; Task 3.5 changed no tracked production, config, dependency, asset, SQL, or operational file. This report update is inside the pre-existing untracked `.kiro/` evidence tree. |

### Validation gaps, approval boundary, and recovery

Credentialed auth/session redirects, role access, all admin API status/error/account paths, Supabase reads/writes/RPC/storage/realtime, registry navigation, setup fallback under real configurations, bootstrap behavior, deployed RLS/grants/policies, and SQL verification were **NOT RUN**. The workspace has no authorized non-production Supabase project, `.env.local`, role credentials, controlled disposable records/accounts, private bootstrap input, database connection, browser/integration test script, production-state inventory, or named owner approval. The SQL health file's rollback-wrapped reset still invokes a stateful RPC and was not executed without an explicitly isolated approved database. No long-running dev server was started.

These missing checks block full approval by design. They do not justify substituting mocks or touching production. Any future High/Critical cleanup proposal must be a dedicated single-contract patch after: (1) affirmative application/operations/database owner signoff; (2) production/deployed-state and external-consumer evidence; (3) focused auth/API/data/script/SQL checks in an isolated non-production environment; and (4) a separately rehearsed restore demonstrating no data repair, schema rollback, secret rotation, or unrelated production change. SQL/schema/data migration work must remain outside the code-cleanup patch.

The Task 3.5 production patch boundary is empty, so current rollback is a no-op. If this evidence update is rejected, remove only this `Wave 4 high-risk contract review` section; do not alter the prior Wave 1B source patch or any preserved high-risk contract.

**Task 3.5 result:** succeeded as a conservative review/no-op. Missing owner, deployed-state, safe integration, and recovery-rehearsal evidence prevented every High/Critical candidate from satisfying the cleanup predicate, so routes, environment contracts, auth/API behavior, Supabase/data names, registry metadata, scripts, SQL history, deployment, and recovery contracts were preserved.

## Preservation property verification after approved waves (Task 3.7)

**Verification timestamp:** `2026-07-16T00:28:11.8805878-04:00`. **Property:** Property 2 — Preservation of Valid, Indirect, and Uncertain Contracts. **Compared state:** baseline commit `37589c72c5488a2daae07844ffcdc035527e1e3a` versus the current workspace containing only the approved tracked Wave 1B closure in `src/features/renewals/RenewalsPage.tsx`. Wave 2, Wave 3, and Wave 4 were evidence-based no-op/defer decisions. No substitute fixture, snapshot, route check, or weakened gate was introduced.

### Exact task-2 artifacts and gate results

| Exact check | Result and baseline comparison |
|---|---|
| `node .kiro/specs/unused-code-cleanup-audit/preservation-oracle.mjs --compare` | Exit 0. The normalized contract digest remains exactly `3b04adef6f9fdf85a276159c6f1b3371af031bd97e6cf08c758a8c0f706800ab`, the unfixed observation-first baseline. |
| `node --test .kiro/specs/unused-code-cleanup-audit/preservation-oracle.test.mjs` | Exit 0; 6/6 tests passed. This is the same deterministic suite from Task 2, including all 2,047 non-empty combinations of the 11 consumer classes, incomplete/uncertain/side-effect boundaries, exact snapshot equality, and validation normalizers. PBT task status was recorded `passed`. Randomized PBT remains not configured and no dependency was added. |
| `node .kiro/specs/unused-code-cleanup-audit/preservation-gates.mjs --run --allow=src/features/renewals/RenewalsPage.tsx` | Exit 0 using the unchanged Task-2 runner and exact one-file approved wave allowlist. The runner executed human lint, machine-normalized lint, strict TypeScript, the audit-only unused probe, production build/route normalization, contract comparison, `git diff --check`, tracked-diff allowlisting, and protected-config checks. |
| `npm run lint` through the consolidated runner | Expected exit 1 with 18 errors and 5 warnings; machine fingerprint `738c8e9eabe8bc2477f640bee2e885db41b73d781fe59bac1e33fa2963de91b5`. Relative to the immutable unfixed baseline, only the approved UC-004 production warning disappeared. The already documented untracked audit-fixture warning occupies the unchanged fifth-warning count; no new production-source diagnostic, severity increase, suppression, or unrelated production diagnostic change occurred. |
| `npx tsc --noEmit` through the consolidated runner | Exit 0, equal to baseline. |
| `npx tsc --noEmit --noUnusedLocals --noUnusedParameters --incremental false` through the consolidated runner | Expected nonzero discovery result with exactly three TS6133 diagnostics: `AlertTriangle` at 4:3, `CircleDollarSign` at 8:3, and `FileClock` at 13:3 in `RenewalsPage.tsx`. The sole delta from the four-finding baseline is approved UC-004 `RenewalDrawer.onClose`; no new unused diagnostic appeared. |
| `npm run build` and normalized route/proxy comparison through the consolidated runner | Exit 0. Exact routes/classifications remain `ƒ /`, `○ /_not-found`, `ƒ /api/admin/users`, `ƒ /change-password`, `ƒ /login`, `○ /manifest.webmanifest`, `○ /setup`, `ƒ /tools`, `ƒ /tools/cs-intake`, `ƒ /tools/cs-intake/queue`, `ƒ /tools/renewals`, plus `ƒ Proxy (Middleware)`. API methods remain `GET`, `POST`, `PATCH`, and `DELETE`; runtime remains `nodejs`. |
| Diff/config/secret review | `git diff --check` passed inside the runner. The only tracked changed file is the exact allowlisted `src/features/renewals/RenewalsPage.tsx`; protected `package.json`, lockfile, TypeScript, ESLint, Next, and npm configs are unchanged. The contract snapshot still records `secretValuesCaptured: false`; no secret value, `.env.local`, private bootstrap input, schema/data operation, SQL execution, ignore, exclusion, or suppression was introduced. |

`preservation-baseline.json` now retains the original unfixed command expectations under `preCleanupValidation` and exposes the reviewed post-Wave-1B expectations under `validation`, as required by Task 2's approved-wave update rule. The contract snapshot hash itself was not changed. This preserves the original four-finding evidence while allowing the same consolidated gate to enforce that only UC-004 disappeared.

### Preserved/review/deferred contracts

The exact oracle comparison proves equality for route and framework conventions, API methods/runtime, proxy export/matcher/session-refresh chain, metadata/manifest, module-registry IDs/roles/status/routes/labels, package scripts/bootstrap flags/private paths, validation scopes/configuration, environment names/public-server visibility/defaults/fallback order, public URLs and asset hashes, Supabase tables/RPCs/storage/realtime/auth names, migration and verification ordering/hashes, and deployment/recovery/upgrade evidence. Source-observed workflow descriptors for auth/session, password change, manager administration, registry navigation, dashboard/rotations, CS intake, queue, renewals, workload, quotes/reports/exports, realtime, and error/permission paths also remain byte-for-byte within the contract digest.

All preserve/manual-review/defer candidates remain protected. UC-005 root `CsIntakeLanding.tsx`, UC-006 root `IntakeQueue.tsx`, and UC-007 root `work-desk-app.tsx` remain tracked and unchanged because the only tracked diff is the Wave 1B renewals file. UC-008–UC-014 public assets remain present with exact pre-cleanup URL/hash entries in the passing oracle. All framework, environment, API/auth/Supabase/data, registry, script, SQL/migration, operations, generated, and externally uncertain elements remain preserved. There is no hidden exclusion, unclassified deletion, client/server-boundary change, route/contract difference, or production workflow code change outside the approved ignored callback closure.

### Applicable workflow checks and unavailable manual evidence

The same authorized manual smoke matrix from Task 2 remains **NOT RUN**. Automation did not start `npm run dev`. This workspace still lacks `.env.local`, a configured non-production Supabase project, authorized agent/customer-service/manager accounts, controlled disposable records, the private bootstrap input, a database connection, and browser/integration automation. Consequently login/logout/session refresh, forced password change, role navigation, admin API mutations/status paths, dashboard/rotations, CS intake/queue, renewals drawer interactions and evidence storage, workload/quotes/reports/exports, realtime/fallback/reconnect, bootstrap, SQL verification, deployment, and rollback procedure execution were not runtime-exercised. Unsafe production account, bootstrap, migration, recovery, schema, data, storage, or destructive SQL operations were intentionally not performed.

For the affected Wave 1B area, strict compilation, production rendering/build discovery, exact route/contract comparison, and the previously documented source trace confirm that the preserved outer `Drawer.onClose`, backdrop and Close-button behavior, selected-state transitions, and renewals API/Supabase wiring remain present. Browser drawer open/close/cancel/save, assignment, contact-evidence, keyboard/backdrop, and realtime checks remain unavailable. These explicit gaps prevent claiming fully runtime-validated status but do not authorize deletion of any uncertain or high-risk contract.

### Files and result

Task 3.7 changed only untracked spec evidence: `preservation-baseline.json` (retained original baseline plus reviewed active validation delta), `preservation-checks.md` (baseline-transition note), and this `audit-report.md` section. It did not alter the existing approved production patch. The tracked production diff remains the one-file Wave 1B closure and no other tracked file differs.

**Task 3.7 result:** succeeded for every currently safe and available automated preservation check. All exact Task-2 fixtures, snapshots, full gates, route/proxy comparisons, diff/config checks, and source-observed contracts passed or matched only the explicitly documented diagnostics and approved UC-004 disappearance. Full credentialed browser/integration/operational acceptance remains unavailable and is explicitly not claimed.
## Isolated-wave rollback exercise (Task 3.8)

**Exercise window:** completed `2026-07-16T00:33:36.1645400-04:00`. **Baseline commit:** `37589c72c5488a2daae07844ffcdc035527e1e3a`. **Commit boundary:** none; no commit was created or authorized. **Starting and final tracked state:** exactly one approved Wave 1B diff in `src/features/renewals/RenewalsPage.tsx`, plus the pre-existing untracked `.kiro/` evidence tree. No destructive reset, checkout, clean, stash, or workspace-wide restore command was used.

### Wave boundary inventory before exercise

| Wave | Candidate IDs / decision | Exact production boundary | Rollback action and expected evidence |
|---|---|---|---|
| Wave 1A | UC-001, UC-002, UC-003 remain proposed/retained; the current source and unused probe prove the icon-removal patch was never applied. | Empty. The three import specifiers remain at lines 4, 8, and 13. | No production rollback is possible or required. Expected evidence is continued presence of all three imports and their three TS6133 findings. A future approved Wave 1A must record and rehearse its own import-only inverse patch. |
| Wave 1B | UC-004, the ignored `RenewalDrawer.onClose` closure; applied and approved in Task 3.2. | One file and three sites only: remove the destructured parameter, inline prop type member, and sole caller-side prop/lambda in `src/features/renewals/RenewalsPage.tsx`. Wave patch SHA-256 `0148E2F70A21CAC512EA4680EBD19D0E6C6A4824982717DE2B217087ECC524AC`; post-wave source Git blob `3c8f9eccc13f94dbc04527dac15accc8589abae4`. | Restore exactly those three sites. Expected rollback evidence: source Git blob `e42ed269044260dd62ba6b1dfc68638a3e2b24be`, no tracked diff, UC-004 returns as the fourth unused diagnostic, strict type/build/routes/contracts pass, and the active outer `Drawer.onClose` remains unchanged. |
| Wave 2 | UC-008–UC-014 preserved/deferred; no candidate approved or removed. | Empty. No asset/style/export/function/type patch exists. | No-op. Expected evidence is exact asset hashes/URLs in the passing contract oracle and no public-file diff. |
| Wave 3 | UC-005–UC-007 preserved/deferred for absent operational approval and unresolved external use. | Empty. No root file was removed or changed. | No-op. Expected evidence is all three root files present/unchanged and no root-file diff. |
| Wave 4 | All High/Critical framework, auth/API, Supabase/data, env/config, registry, script, SQL, deployment, and recovery contracts preserved/deferred. | Empty. No high-risk production patch exists. | No-op. Expected evidence is exact contract-oracle equality and no config, env, SQL/schema/data, script, route, or operational-document diff. |

Only Wave 1B therefore had an executable rollback. The no-op boundaries for Waves 1A and 2–4 were verified from the current tracked diff and prior decision evidence rather than fabricating changes to preserved candidates.

### Procedure exercised

1. Captured the isolated Wave 1B forward patch outside the workspace and generated its inverse. The forward and inverse SHA-256 values are `0148E2F70A21CAC512EA4680EBD19D0E6C6A4824982717DE2B217087ECC524AC` and `58BC79C0E9D45D52E21A4102D5C20029EB1E5CC08582043C0BF666E6937CA42C`.
2. Applied only the inverse three-site edit to `src/features/renewals/RenewalsPage.tsx`: restored `onClose` in the `RenewalDrawer` destructuring, restored `onClose: () => void` in the inline type, and restored `onClose={() => setSelectedId(null)}` on the sole `RenewalDrawer` caller. The separate outer `<Drawer ... onClose={() => setSelectedId(null)}>` was not edited.
3. Validated the rollback state serially. `git diff --quiet -- src/features/renewals/RenewalsPage.tsx` exited 0 and the source blob exactly matched baseline blob `e42ed269044260dd62ba6b1dfc68638a3e2b24be`; `git status --short` contained only `?? .kiro/`.
4. Reapplied only the original three-site Wave 1B patch after the rehearsal. The final source blob returned to `3c8f9eccc13f94dbc04527dac15accc8589abae4`, the complete forward-patch hash exactly matched the captured pre-exercise hash, and the only tracked changed file returned to `src/features/renewals/RenewalsPage.tsx`.
5. `git apply --check` against the captured inverse patch passed in the restored post-wave state. A future failure/rejection procedure is therefore: capture/retain the approved one-file forward patch; run `git apply --check` on its inverse; apply only that inverse patch; validate the baseline state; and, only for a rehearsal rather than a real rejection, reapply the captured forward patch. Never use `git reset --hard`, workspace-wide checkout/restore, `git clean`, or any operation that includes unrelated paths.

### Rollback-state validation evidence

| Gate | Exercised rollback result |
|---|---|
| Lint | `npm run lint` exited 1 with 24 total findings: the established 18 errors, the five baseline production warnings (UC-001–UC-004 plus the pre-existing `<img>` warning), and one additional warning in the untracked audit fixture. UC-004 returned at `RenewalsPage.tsx:479:3`; no production diagnostic outside the expected baseline appeared. |
| Strict type-check | `npx tsc --noEmit` exited 0. |
| Candidate-specific unused gate | `npx tsc --noEmit --noUnusedLocals --noUnusedParameters --incremental false` exited 2 with exactly four TS6133 findings: UC-001 at 4:3, UC-002 at 8:3, UC-003 at 13:3, and restored UC-004 at 479:3. This is the expected pre-wave candidate evidence. |
| Production build | `npm run build` exited 0 under Next.js 16.2.10. |
| Normalized routes/proxy | Exact baseline: `ƒ /`, `○ /_not-found`, `ƒ /api/admin/users`, `ƒ /change-password`, `ƒ /login`, `○ /manifest.webmanifest`, `○ /setup`, `ƒ /tools`, `ƒ /tools/cs-intake`, `ƒ /tools/cs-intake/queue`, `ƒ /tools/renewals`, and `ƒ Proxy (Middleware)`. |
| Contract comparison | `preservation-oracle.mjs --compare` exited 0 with exact baseline digest `3b04adef6f9fdf85a276159c6f1b3371af031bd97e6cf08c758a8c0f706800ab`. API methods/runtime, proxy, env visibility/fallbacks, registry, scripts, public URLs, Supabase names, SQL order/hashes, and deployment/recovery contracts remained exact. |
| Deterministic preservation fixtures | `preservation-oracle.test.mjs` passed 6/6, including all 2,047 non-empty consumer combinations and exact contract equality. Randomized PBT remains not configured. |
| Diff and unrelated-work gates | `git diff --check` exited 0; rollback source and baseline source blobs matched; protected package/lock/TypeScript/ESLint/Next/npm config comparison exited 0; no unrelated tracked file changed. |
| Affected workflow/preservation trace | Exact source-blob restoration proves the complete pre-wave renewals source returned. The active outer `Drawer.onClose`, backdrop `onMouseDown={onClose}`, Close-button `onClick={onClose}`, panel propagation stop, selected-state callback, and all assignment/contact-evidence/save/final-outcome/requote API wiring remained present. |

### Restored post-wave validation evidence

After reapplying the approved patch, `preservation-gates.mjs --run --allow=src/features/renewals/RenewalsPage.tsx` exited 0. Lint returned the reviewed post-Wave-1B fingerprint `738c8e9eabe8bc2477f640bee2e885db41b73d781fe59bac1e33fa2963de91b5` with 18 errors/5 warnings; strict TypeScript exited 0; the unused probe returned only UC-001–UC-003; build and the exact normalized route/proxy oracle passed; contract comparison passed; `git diff --check` and the one-file allowlist passed. The same deterministic fixture suite passed 6/6 again. Candidate-specific source gates confirmed no `RenewalDrawer.onClose` caller remained while the active outer drawer backdrop and Close-button callbacks remained. `git apply --check` confirmed the inverse patch is still applicable.

### Runtime limitations and reversibility determination

Browser renewals checks—drawer open, backdrop close, Close-button close, cancel/reopen, save, assignment, contact-evidence upload/download, final outcomes, re-quote, keyboard behavior, realtime, and error paths—remain **NOT RUN**. `.env.local` and `private/bootstrap-users.json` are absent, and no authorized non-production Supabase project, role credentials, controlled renewal records, storage fixture, browser/integration test script, or safe data environment is available. Automation did not start a long-running development server and did not use production credentials or data. This gap prevents claiming fully runtime-validated acceptance but does not invalidate the source-only rollback proof; any runtime failure or rejected review must invoke this same one-wave inverse procedure and leave the rollback in place.

Wave 1B is acceptably reversible: its complete boundary is one source-only prop/caller closure; rollback exactly restored the baseline tracked tree and required no data repair, schema migration or rollback, SQL, account operation, storage cleanup, cache purge, secret read or rotation, environment change, deployment change, dependency/config change, or unrelated production edit. Waves 1A and 2–4 have empty applied boundaries and likewise require no repair; candidates lacking safe reversibility or approval remain deferred.

**Task 3.8 result:** completed successfully for every applied wave boundary. Wave 1B rollback and reapplication were exercised non-destructively with exact before/rollback/after hashes and complete available automated gates. All no-op/deferred wave boundaries were explicitly reconciled. Full credentialed browser/runtime evidence remains unavailable and is not claimed.
## Final audit/cleanup checkpoint (Task 4)

**Final checkpoint window:** `2026-07-16T00:38:12.8434779-04:00` through `2026-07-16T00:38:59.7862584-04:00`. **Baseline commit:** `37589c72c5488a2daae07844ffcdc035527e1e3a`. **Final tracked boundary:** only `src/features/renewals/RenewalsPage.tsx`, with Git blob `3c8f9eccc13f94dbc04527dac15accc8589abae4` and diff stat `1 file changed, 1 insertion(+), 3 deletions(-)`. The `.kiro/` report/tooling tree remains untracked spec evidence. No commit was created.

### Final candidate reconciliation

Every inventory candidate has exactly one final disposition; no candidate disappeared from reporting.

| Final disposition | Count | Candidate IDs | Final rationale / required reviewer |
|---|---:|---|---|
| Removed in approved wave | 1 | UC-004 | Wave 1B removed only the ignored `RenewalDrawer.onClose` parameter/type/caller closure. Available automated gates and source-contract smoke passed; credentialed browser renewals acceptance remains not run. |
| Deferred | 3 | UC-001, UC-002, UC-003 | The unused icon specifiers remain present and continue to be the only audit-only TypeScript findings. Wave 1A has an empty applied boundary; no removal is claimed. A future import-only wave requires explicit code-owner approval and its own pre/post gates. |
| Manual review | 10 | UC-005–UC-014 | UC-005–UC-007 require release/operations owner confirmation of no manual/external consumer; UC-006 and UC-007 also require High/Critical-risk production-state review. UC-008–UC-014 require web/operations confirmation of no direct-public-URL consumer, with brand-owner review additionally required for UC-010 and UC-011. |
| Preserved | 0 candidate IDs | — | No numbered candidate is assigned a second disposition. Separately inventoried framework/routes, API/auth, Supabase/data, environment, registry, package/script, SQL/migration, configuration, generated, deployment, recovery, and other verified/uncertain contracts remain preserved by policy and exact oracle comparison. |

**Final candidate counts:** 14 total = 1 removed + 3 deferred + 10 manual review + 0 numbered preserved. The broader inventory contains no unclassified removal: all non-candidate contracts remain preserved.

### Final before/after validation evidence

| Exact check | Immutable pre-cleanup result | Final result | Comparison |
|---|---|---|---|
| `npm run lint` | Exit 1; 23 findings, 18 errors/5 warnings; fingerprint `c32476569a96e35b20f8aa885b170e8ff08f1f2d8d4f8a512e45d8d3b4aeeb2e`. | Exit 1; 18 errors/5 warnings; fingerprint `738c8e9eabe8bc2477f640bee2e885db41b73d781fe59bac1e33fa2963de91b5`. | Passed the approved diagnostic comparison. UC-004 disappeared; no unrelated production diagnostic or severity changed. The untracked deterministic audit fixture contributes the replacement fifth warning and is outside the production patch. |
| `npx tsc --noEmit` | Exit 0. | Exit 0. | Exact pass. |
| `npx tsc --noEmit --noUnusedLocals --noUnusedParameters --incremental false` | Nonzero discovery result with UC-001–UC-004. | Nonzero discovery result with exactly UC-001 `AlertTriangle` at 4:3, UC-002 `CircleDollarSign` at 8:3, and UC-003 `FileClock` at 13:3. | Only approved UC-004 disappeared; no new finding. |
| `npm run build` | Exit 0. | Exit 0. | Exact pass under Next.js 16.2.10. |
| `node .kiro/specs/unused-code-cleanup-audit/preservation-oracle.mjs --compare` (inside consolidated gate) | Digest `3b04adef6f9fdf85a276159c6f1b3371af031bd97e6cf08c758a8c0f706800ab`. | Exact digest match. | All normalized production contracts unchanged. |
| `node --test .kiro/specs/unused-code-cleanup-audit/preservation-oracle.test.mjs` | 6/6 deterministic fixtures passed. | 6/6 passed in `291.8631 ms`. | Same exhaustive deterministic suite; no substitute fixture. |
| Diff/reference/config review | No tracked cleanup diff. | `git diff --check` passed; exact allowlist contains only `src/features/renewals/RenewalsPage.tsx`; protected package/lock/TypeScript/ESLint/Next/npm configs unchanged. Post-wave reference analysis leaves no UC-004 caller/type orphan and preserves active `Drawer.onClose`. | Passed. |

The consolidated final command was `node .kiro/specs/unused-code-cleanup-audit/preservation-gates.mjs --run --allow=src/features/renewals/RenewalsPage.tsx`; it exited 0 and serialized lint, machine lint, strict TypeScript, the audit-only unused probe, production build, route/proxy normalization, contract comparison, diff checking, changed-file allowlisting, and protected-config review.

### Final route, proxy, and API oracle

The final production build contains every baseline route with unchanged relevant classification: `ƒ /`, `○ /_not-found`, `ƒ /api/admin/users`, `ƒ /change-password`, `ƒ /login`, `○ /manifest.webmanifest`, `○ /setup`, `ƒ /tools`, `ƒ /tools/cs-intake`, `ƒ /tools/cs-intake/queue`, and `ƒ /tools/renewals`, plus `ƒ Proxy (Middleware)`. `src/proxy.ts` still exposes named `proxy` and `config.matcher`; the session/cookie refresh contract remains in the exact oracle. `/api/admin/users` remains a dynamic Node route exporting `GET`, `POST`, `PATCH`, and `DELETE`; authentication, active-manager authorization, server-only secret handling, and observed status/error/account-operation contracts are unchanged.

### Smoke, integration, approvals, and validation gaps

- **Passed available affected-area checks:** strict compile, production render/build discovery, exact route/API/proxy/contract comparison, UC-004 dependency/reference closure, and source-contract tracing for selected-state open/close, outer drawer backdrop and Close-button callbacks, propagation stop, and unchanged renewals assignment/contact-evidence/save/outcome/re-quote wiring.
- **Not run:** browser drawer open/backdrop/Close/cancel/reopen/save, keyboard behavior, assignment, contact-evidence storage, final outcomes, re-quote, realtime, and error paths; the broader auth/session, role, admin API, Supabase read/write/RPC/storage/realtime, bootstrap, SQL, deployment, and recovery smoke matrix also remains not run.
- **Reason:** no `.env.local`, authorized non-production Supabase project, role credentials, controlled disposable records/accounts, private bootstrap input, storage fixture, database connection, browser/integration test script, or named operational reviewer is available. No long-running `npm run dev` server was started. Unsafe production, bootstrap, account, schema, data, storage, migration, recovery, or SQL operations were intentionally not performed.
- **Approval status:** Wave 1B's bounded implementation/rollback approval is recorded by the completed wave sequence, but no named reviewer has supplied credentialed runtime acceptance. Required reviewer confirmation remains outstanding for all unresolved external/operational candidates UC-005–UC-014 and for all High/Critical-risk dispositions/contracts, including root snapshots with auth/admin/data behavior, public/brand URL consumers, API/auth/Supabase/env/script/SQL/deployment/recovery preservation, and production-state/recovery evidence. These candidates remain manual review/preserved and are not authorized for removal.
- **Validation claim:** all safe and currently available automated gates pass, but the cleanup is **not fully runtime/integration validated**. The remaining gaps require user/reviewer action; they are not converted into passing evidence.

### Wave boundaries, rollback, and scope confirmation

Wave 1A has an empty boundary and UC-001–UC-003 remain deferred. Wave 1B is the sole applied boundary: one source file and the exact ignored parameter/type/caller closure. Its non-destructive rollback and reapplication were exercised in Task 3.8: rollback restored baseline blob `e42ed269044260dd62ba6b1dfc68638a3e2b24be`, four unused diagnostics, strict/build/routes/contracts, and an empty tracked diff; reapplication restored post-wave blob `3c8f9eccc13f94dbc04527dac15accc8589abae4` and the passing final gates. Waves 2–4 have empty production boundaries because uncertain and High/Critical-risk candidates were preserved/manual-review/deferred. No rollback requires data repair, schema migration, SQL, account/storage operation, secret rotation, environment change, dependency/config change, or unrelated production edit.

Final diff/oracle review confirms that no unrelated refactor or formatting churn, dependency or lockfile change, config weakening, suppression, ignore/exclusion, route/classification change, API-method change, proxy change, client/server-boundary change, environment rename/fallback change, public-asset change, registry/script change, SQL/schema/data operation, migration/deployment/recovery edit, or secret value entered any cleanup wave. Secret values were neither read nor recorded.

### Unchanged production contracts

Routes and route classifications; `Proxy (Middleware)` and matcher/session refresh; `/api/admin/users` methods/runtime/auth-manager semantics; metadata and manifest; login/logout, setup, forced-password and role gates; module-registry IDs/routes/roles/labels/status; public/server environment names, visibility, defaults and secret fallback order; package/bootstrap commands, flags and private paths; Supabase table/RPC/storage/realtime/auth names; public URLs/hashes; migration/verification order and SQL hashes; deployment/recovery procedures; and source-observed dashboard, CS intake/queue, renewals, workload, quote/report/export, realtime and error/permission workflows all remain unchanged.

Optional randomized property-based automation is **not configured**. No exact-version PBT dependency or test-infrastructure/lockfile change was separately approved or completed. The 6/6 `node:test` results are deterministic exhaustive fixtures and are not represented as randomized property coverage.

**Final finding:** the only applied cleanup is UC-004, removed in a bounded and demonstrated-reversible Wave 1B with all available automated preservation gates passing. Thirteen numbered candidates remain intentionally retained under `deferred` or `manual review`. User/reviewer confirmation is still required to resolve external/operational consumers, High/Critical-risk dispositions, and the listed credentialed runtime gaps; until then, no further cleanup is authorized.