import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SPEC_DIR, "../../..");
export const DEFAULT_BASELINE = path.join(SPEC_DIR, "preservation-baseline.json");

export const CONSUMER_CLASSES = [
  "direct",
  "typeOnly",
  "dynamic",
  "framework",
  "sideEffect",
  "configuration",
  "environment",
  "script",
  "integration",
  "operational",
  "external",
];

export function isBugCondition(input) {
  const evidence = input.evidence ?? {};
  const consumers = evidence.consumers ?? {};
  return Boolean(
    input.repositoryMaintained
      && input.retained
      && evidence.complete
      && !evidence.uncertain
      && CONSUMER_CLASSES.every((consumerClass) => evidence.applicable?.includes(consumerClass))
      && CONSUMER_CLASSES.every((consumerClass) => !(consumers[consumerClass]?.length > 0))
      && !(evidence.requiredSideEffects?.length > 0),
  );
}

function slash(value) {
  return value.split(path.sep).join("/");
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(absolute)));
    else output.push(absolute);
  }
  return output;
}

async function text(relativePath, root = REPOSITORY_ROOT) {
  return readFile(path.join(root, relativePath), "utf8");
}

async function sha256(relativePath, root = REPOSITORY_ROOT) {
  const content = await readFile(path.join(root, relativePath));
  return createHash("sha256").update(content).digest("hex");
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function matches(source, regex, group = 1) {
  return [...source.matchAll(regex)].map((match) => match[group]);
}

function parseStringLiteral(raw) {
  if (raw.startsWith('"')) return JSON.parse(raw);
  return raw.slice(1, -1).replaceAll("\\'", "'").replaceAll("\\\\", "\\");
}

async function sourceFiles(root) {
  const roots = ["src", "scripts"];
  const files = [];
  for (const relative of roots) {
    for (const absolute of await walk(path.join(root, relative))) {
      if (/\.(?:ts|tsx|mjs)$/.test(absolute)) files.push(absolute);
    }
  }
  return files;
}

async function loadRegistry(root) {
  const source = await text("src/platform/module-registry.ts", root);
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const registryModule = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
  return registryModule.appModules.map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    route: entry.route,
    roles: [...entry.roles],
    status: entry.status,
  }));
}

async function captureRoutes(root) {
  const appRoot = path.join(root, "src/app");
  const files = await walk(appRoot);
  const routes = [{ path: "/_not-found", classification: "static", marker: "○", source: "framework-generated" }];
  for (const absolute of files) {
    const relative = slash(path.relative(appRoot, absolute));
    if (relative.endsWith("/page.tsx") || relative === "page.tsx") {
      const routePart = relative === "page.tsx" ? "" : relative.slice(0, -"/page.tsx".length);
      const source = await readFile(absolute, "utf8");
      const dynamic = /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/.test(source);
      routes.push({
        path: `/${routePart}` || "/",
        classification: dynamic ? "dynamic" : "static",
        marker: dynamic ? "ƒ" : "○",
        source: slash(path.relative(root, absolute)),
      });
    }
    if (relative.endsWith("/route.ts") || relative === "route.ts") {
      const routePart = relative === "route.ts" ? "" : relative.slice(0, -"/route.ts".length);
      routes.push({
        path: `/${routePart}` || "/",
        classification: "dynamic",
        marker: "ƒ",
        source: slash(path.relative(root, absolute)),
      });
    }
  }
  routes.push({
    path: "/manifest.webmanifest",
    classification: "static",
    marker: "○",
    source: "src/app/manifest.ts",
  });
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

async function captureSupabase(root, files) {
  const tables = [];
  const rpcs = [];
  const channels = [];
  const storageBuckets = [];
  const authMethods = [];
  for (const absolute of files) {
    const source = await readFile(absolute, "utf8");
    tables.push(...matches(source, /\.from\(\s*(["'][A-Za-z0-9_-]+["'])\s*\)/g).map(parseStringLiteral));
    rpcs.push(...matches(source, /\.rpc\(\s*(["'][A-Za-z0-9_-]+["'])/g).map(parseStringLiteral));
    channels.push(...matches(source, /\.channel\(\s*(["'][^"']+["'])/g).map(parseStringLiteral));
    storageBuckets.push(...matches(source, /\.storage\s*\n?\s*\.from\(\s*(["'][^"']+["'])/g).map(parseStringLiteral));
    storageBuckets.push(...matches(source, /\.storage\.from\(\s*(["'][^"']+["'])/g).map(parseStringLiteral));
    authMethods.push(...matches(source, /\.auth(?:\.admin)?\.([A-Za-z0-9_]+)\s*\(/g));
  }
  const buckets = uniqueSorted(storageBuckets);
  return {
    tables: uniqueSorted(tables.filter((name) => !buckets.includes(name))),
    rpcs: uniqueSorted(rpcs),
    storageBuckets: buckets,
    realtimeChannels: uniqueSorted(channels),
    authMethods: uniqueSorted(authMethods),
  };
}

function sourceEvidence(relativePath, observations) {
  return { relativePath, observations };
}

export async function captureContracts(root = REPOSITORY_ROOT) {
  const files = await sourceFiles(root);
  const allSource = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  const packageJson = JSON.parse(await text("package.json", root));
  const tsconfig = JSON.parse(await text("tsconfig.json", root));
  const proxySource = await text("src/proxy.ts", root);
  const proxyMatcherRaw = proxySource.match(/matcher\s*:\s*\[\s*((?:"(?:\\.|[^"])*")|(?:'(?:\\.|[^'])*'))/)?.[1];
  const apiSource = await text("src/app/api/admin/users/route.ts", root);
  const envExample = await text(".env.example", root);
  const publicFiles = (await walk(path.join(root, "public"))).map((file) => slash(path.relative(path.join(root, "public"), file)));
  const migrations = (await readdir(path.join(root, "supabase/migrations"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const verification = (await readdir(path.join(root, "supabase/verification"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const contractFiles = [
    ".env.example",
    ".npmrc",
    "eslint.config.mjs",
    "next.config.ts",
    "package.json",
    "postcss.config.mjs",
    "scripts/bootstrap-users.mjs",
    "src/app/api/admin/users/route.ts",
    "src/app/layout.tsx",
    "src/app/manifest.ts",
    "src/lib/supabase/proxy.ts",
    "src/platform/module-registry.ts",
    "src/proxy.ts",
    "tsconfig.json",
    "LIVE-DEPLOYMENT-GUIDE.md",
    "SETUP-CHECKLIST.md",
    "TEST-CHECKLIST-v0.9.4.1.md",
    "UPGRADE-v0.9.4.1.md",
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(contractFiles.map(async (file) => [file, await sha256(file, root)])),
  );
  const publicAssets = await Promise.all(publicFiles.map(async (file) => ({
    url: `/${file}`,
    sha256: await sha256(`public/${file}`, root),
  })));
  const sqlFiles = [
    "supabase/schema.sql",
    "supabase/seed-template.sql",
    ...migrations.map((file) => `supabase/migrations/${file}`),
    ...verification.map((file) => `supabase/verification/${file}`),
    "v0.9.8-health-verification.sql",
    "v0.9.9-install-readiness.sql",
  ];
  const sqlHashes = Object.fromEntries(
    await Promise.all(sqlFiles.map(async (file) => [file, await sha256(file, root)])),
  );

  return {
    formatVersion: 1,
    property: "Property 2: Preservation — Valid, Indirect, and Uncertain Contracts",
    routes: await captureRoutes(root),
    api: {
      route: "/api/admin/users",
      runtime: apiSource.match(/export\s+const\s+runtime\s*=\s*["']([^"']+)["']/)?.[1] ?? null,
      methods: uniqueSorted(matches(apiSource, /export\s+async\s+function\s+(GET|POST|PATCH|DELETE|PUT|HEAD|OPTIONS)\s*\(/g)),
    },
    proxy: {
      export: /export\s+async\s+function\s+proxy\s*\(/.test(proxySource) ? "proxy" : null,
      matcher: proxyMatcherRaw ? parseStringLiteral(proxyMatcherRaw) : null,
      sessionRefresh: "updateSession -> createServerClient -> cookies.getAll/setAll -> auth.getClaims",
    },
    metadata: {
      title: "New Hope Work Desk",
      description: "Internal sales rotation, backup service, workload, and performance desk.",
      applicationName: "New Hope Work Desk",
      icon: "/icon-192.png",
      apple: "/icon-192.png",
      viewportThemeColor: "#223f7a",
    },
    manifest: {
      route: "/manifest.webmanifest",
      name: "New Hope Work Desk",
      shortName: "Work Desk",
      description: "New Hope Insurance internal sales operations desk.",
      startUrl: "/",
      display: "standalone",
      backgroundColor: "#f5f7fb",
      themeColor: "#115c43",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    },
    moduleRegistry: await loadRegistry(root),
    package: {
      scripts: packageJson.scripts,
      bootstrapCliFlags: uniqueSorted(matches(await text("scripts/bootstrap-users.mjs", root), /process\.argv\.includes\(\s*(["'][^"']+["'])\s*\)/g).map(parseStringLiteral)),
      bootstrapPrivateInputs: ["private/bootstrap-users.json", "private/PRIVATE-USER-CREDENTIALS.txt"],
    },
    validation: {
      tsconfig,
      eslintGlobalIgnores: [".next/**", "out/**", "build/**", "next-env.d.ts"],
      nextConfig: {},
      postcssPlugins: ["@tailwindcss/postcss"],
      npmrc: (await text(".npmrc", root)).trim().split(/\r?\n/),
    },
    environment: {
      names: uniqueSorted([
        ...matches(allSource, /process\.env\.([A-Z][A-Z0-9_]*)/g),
        ...matches(envExample, /^#?\s*([A-Z][A-Z0-9_]*)=/gm),
      ]),
      contracts: [
        { name: "NEXT_PUBLIC_SUPABASE_URL", visibility: "public", requiredBy: ["browser", "server", "proxy", "admin-api", "bootstrap"], default: null },
        { name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", visibility: "public", requiredBy: ["browser", "server", "proxy"], default: null },
        { name: "NEXT_PUBLIC_AUTH_EMAIL_DOMAIN", visibility: "public", requiredBy: ["login", "admin-api", "bootstrap"], default: "workdesk.newhope.local" },
        { name: "SUPABASE_SECRET_KEY", visibility: "server-only", requiredBy: ["admin-api", "bootstrap"], default: null },
        { name: "SUPABASE_SERVICE_ROLE_KEY", visibility: "server-only legacy fallback", requiredBy: ["admin-api", "bootstrap"], default: null },
      ],
      fallbackOrder: [
        "SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY",
        "NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || workdesk.newhope.local",
      ],
      secretValuesCaptured: false,
    },
    publicAssets,
    supabase: await captureSupabase(root, files),
    databaseArtifacts: {
      migrations,
      verification,
      rootVerification: ["v0.9.8-health-verification.sql", "v0.9.9-install-readiness.sql"],
      schema: "supabase/schema.sql",
      seedTemplate: "supabase/seed-template.sql",
      sqlHashes,
    },
    operations: {
      deployment: sourceEvidence("LIVE-DEPLOYMENT-GUIDE.md", [
        "new installs run supabase/schema.sql once",
        "existing databases apply retained migrations in version order",
        "npm ci, npm run lint, and npm run build precede deployment",
        "Vercel keeps SUPABASE_SECRET_KEY server-only",
      ]),
      recovery: sourceEvidence("LIVE-DEPLOYMENT-GUIDE.md", [
        "emergency password reset is manager-only and uses --reset-passwords",
        "normal deployment must not run emergency reset",
      ]),
      upgrade: sourceEvidence("UPGRADE-v0.9.4.1.md", [
        "back up database/repository before upgrade",
        "run ordered migrations and read-only verification",
        "rollback restores application backup and preserves additive database objects",
      ]),
    },
    workflows: [
      { id: "auth-session", baseline: "setup when Supabase config absent; login when claims absent; inactive users return to login; proxy refreshes claims/cookies", evidence: ["src/app/page.tsx", "src/lib/supabase/proxy.ts"] },
      { id: "password", baseline: "must_change_password redirects to /change-password; successful auth update and complete_password_change return to /", evidence: ["src/app/change-password/page.tsx", "src/components/change-password-form.tsx"] },
      { id: "admin", baseline: "GET/POST/PATCH/DELETE require active manager; errors retain 400/401/403/404/409/503 paths", evidence: ["src/app/api/admin/users/route.ts"] },
      { id: "navigation", baseline: "active registry modules are filtered by role and presentation mapping", evidence: ["src/platform/module-registry.ts", "src/components/operations-dock.tsx", "src/features/platform/ToolsHub.tsx"] },
      { id: "dashboard-rotations", baseline: "dashboard loads reset RPC/data; WhatsApp, RingCentral, and workload rotations remain independent", evidence: ["src/lib/dashboard-data.ts", "src/components/work-desk-app.tsx"] },
      { id: "cs-intake", baseline: "create/edit/submit/list intake with customer-service and manager access", evidence: ["src/features/cs-intake/CsIntakeLanding.tsx", "src/features/cs-intake/api.ts"] },
      { id: "intake-queue", baseline: "agent claim, manager assignment, return, and conversion remain available", evidence: ["src/features/cs-intake/IntakeQueue.tsx", "src/features/cs-intake/api.ts"] },
      { id: "renewals", baseline: "import, assignment, contact evidence storage, workflow status, events, aliases, and manager updates remain available", evidence: ["src/features/renewals/RenewalsPage.tsx", "src/features/renewals/api.ts"] },
      { id: "workload", baseline: "list, reassign, and void workload preserve permission/error behavior", evidence: ["src/features/workload/WorkloadLog.tsx", "src/features/workload/api.ts"] },
      { id: "quotes-reports-exports", baseline: "quote lifecycle, pending pricing, reports, CSV/export UI, and outcomes remain unchanged", evidence: ["src/components/work-desk-app.tsx"] },
      { id: "realtime", baseline: "channels, 60-second fallback, visibility/focus, online, and reconnect refresh paths remain unchanged", evidence: ["src/components/work-desk-app.tsx", "src/features/cs-intake/CsIntakeLanding.tsx", "src/features/cs-intake/IntakeQueue.tsx", "src/features/renewals/RenewalsPage.tsx"] },
      { id: "errors-permissions", baseline: "missing config, unauthenticated, inactive, wrong-role, validation, permission, and integration errors retain observed handling", evidence: ["src/lib/tool-session.ts", "src/app/api/admin/users/route.ts"] },
    ],
    sourceHashes,
    nextGuidance: [
      "node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md",
      "node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/layout.md",
      "node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md",
      "node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md",
      "node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/public-folder.md",
      "node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/manifest.md",
    ],
  };
}

export function snapshotDigest(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export async function compareToBaseline(baselinePath = DEFAULT_BASELINE, root = REPOSITORY_ROOT) {
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const actual = await captureContracts(root);
  assert.equal(actual.formatVersion, baseline.formatVersion, "oracle format changed");
  assert.equal(snapshotDigest(actual), baseline.snapshotSha256, "preservation snapshot differs from the pre-cleanup observation");
  return actual;
}

async function main() {
  const command = process.argv[2] ?? "--compare";
  if (command === "--print") {
    process.stdout.write(`${JSON.stringify(await captureContracts(), null, 2)}\n`);
    return;
  }
  if (command === "--digest") {
    process.stdout.write(`${snapshotDigest(await captureContracts())}\n`);
    return;
  }
  if (command === "--compare") {
    await compareToBaseline(process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_BASELINE);
    console.log("Preservation oracle matches the recorded pre-cleanup baseline exactly.");
    return;
  }
  throw new Error(`Unknown command: ${command}. Use --print, --digest, or --compare.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
