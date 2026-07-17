import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeBuildOracle,
  normalizeLintJson,
  normalizeUnusedDiagnostics,
} from "./preservation-gates.mjs";
import {
  CONSUMER_CLASSES,
  captureContracts,
  compareToBaseline,
  isBugCondition,
} from "./preservation-oracle.mjs";

function subject(overrides = {}) {
  return {
    repositoryMaintained: true,
    retained: true,
    evidence: {
      complete: true,
      uncertain: false,
      applicable: [...CONSUMER_CLASSES],
      consumers: Object.fromEntries(CONSUMER_CLASSES.map((name) => [name, []])),
      requiredSideEffects: [],
      ...overrides,
    },
  };
}

// **Validates: Requirements 1.5, 2.2, 2.5, 3.1, 3.3, 3.4, 3.5**
test("Property 2 preserves every deterministic combination containing a valid consumer", () => {
  const combinationCount = 2 ** CONSUMER_CLASSES.length;
  for (let mask = 1; mask < combinationCount; mask += 1) {
    const consumers = Object.fromEntries(
      CONSUMER_CLASSES.map((name, index) => [name, mask & (1 << index) ? [`fixture:${name}`] : []]),
    );
    assert.equal(
      isBugCondition(subject({ consumers })),
      false,
      `consumer mask ${mask.toString(2).padStart(CONSUMER_CLASSES.length, "0")} must be preserved`,
    );
  }
});

// **Validates: Requirements 2.2, 2.4, 2.5, 2.6, 3.1, 3.8, 3.9**
test("Property 2 preserves incomplete, uncertain, side-effectful, external, and non-repository fixtures", () => {
  const fixtures = [
    subject({ complete: false }),
    subject({ uncertain: true }),
    subject({ requiredSideEffects: ["registration"] }),
    subject({ applicable: CONSUMER_CLASSES.filter((name) => name !== "external") }),
    { ...subject(), repositoryMaintained: false },
    { ...subject(), retained: false },
  ];
  for (const fixture of fixtures) assert.equal(isBugCondition(fixture), false);
});

// This boundary case keeps the classifier meaningful without authorizing cleanup.
test("complete retained no-consumer fixture remains the only bug-condition shape", () => {
  assert.equal(isBugCondition(subject()), true);
});

// **Validates: Requirements 1.4, 1.6, 2.4, 2.6, 3.1–3.9**
test("Property 2 current contracts exactly match the observation-first baseline", async () => {
  const contracts = await compareToBaseline();
  assert.deepEqual(contracts.api.methods, ["DELETE", "GET", "PATCH", "POST"]);
  assert.equal(contracts.proxy.export, "proxy");
  assert.equal(contracts.environment.secretValuesCaptured, false);
  assert.ok(contracts.routes.some((route) => route.path === "/manifest.webmanifest"));
  assert.ok(contracts.supabase.storageBuckets.includes("renewal-contact-evidence"));
  assert.ok(contracts.supabase.realtimeChannels.includes("work-desk-live"));
});

// **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.7**
test("snapshot exposes all required review categories without secret values", async () => {
  const contracts = await captureContracts();
  assert.ok(contracts.routes.length > 0);
  assert.ok(contracts.moduleRegistry.length > 0);
  assert.ok(contracts.package.bootstrapCliFlags.includes("--reset-passwords"));
  assert.ok(contracts.databaseArtifacts.migrations.length > 0);
  assert.deepEqual(
    contracts.environment.fallbackOrder,
    [
      "SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY",
      "NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || workdesk.newhope.local",
    ],
  );
  assert.equal(JSON.stringify(contracts).includes("YOUR_SECRET_KEY"), false);
});

// **Validates: Requirements 1.4, 2.4, 2.6, 3.2, 3.7**
test("validation normalizers retain diagnostic identities and route classifications", () => {
  const lint = normalizeLintJson(JSON.stringify([{
    filePath: "C:/repo/example.ts",
    messages: [{ ruleId: "rule/id", severity: 1, line: 2, column: 3, message: "observed" }],
  }]), "C:/repo");
  assert.deepEqual({ errors: lint.errors, warnings: lint.warnings }, { errors: 0, warnings: 1 });
  assert.equal(lint.fingerprint.length, 64);

  assert.deepEqual(
    normalizeUnusedDiagnostics("src/example.ts:2:3 - error TS6133: 'x' is declared but its value is never read."),
    [{ file: "src/example.ts", line: 2, column: 3, code: "TS6133", message: "'x' is declared but its value is never read." }],
  );

  assert.deepEqual(
    normalizeBuildOracle("┌ ƒ /\n├ ○ /setup\n└ ƒ /api/example\nƒ Proxy (Middleware)"),
    {
      routes: [
        { marker: "ƒ", path: "/" },
        { marker: "ƒ", path: "/api/example" },
        { marker: "○", path: "/setup" },
      ],
      proxy: "Proxy (Middleware)",
    },
  );
});
