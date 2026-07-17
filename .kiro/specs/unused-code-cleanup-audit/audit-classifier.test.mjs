import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { CONSUMER_CLASSES, isBugCondition } from "./preservation-oracle.mjs";

const SPEC_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SPEC_DIRECTORY, "../../..");
const RENEWALS_PATH = path.join(REPOSITORY_ROOT, "src/features/renewals/RenewalsPage.tsx");

function completeSubject(consumers = {}, overrides = {}) {
  return {
    repositoryMaintained: true,
    retained: true,
    evidence: {
      complete: true,
      uncertain: false,
      applicable: [...CONSUMER_CLASSES],
      consumers: Object.fromEntries(
        CONSUMER_CLASSES.map((consumerClass) => [consumerClass, consumers[consumerClass] ?? []]),
      ),
      requiredSideEffects: [],
      ...overrides,
    },
  };
}

function identifierCount(node, name) {
  let count = 0;
  function visit(current) {
    if (ts.isIdentifier(current) && current.text === name) count += 1;
    ts.forEachChild(current, visit);
  }
  visit(node);
  return count;
}

async function retainedRenewalsCounterexamples() {
  const sourceText = await readFile(RENEWALS_PATH, "utf8");
  const source = ts.createSourceFile(RENEWALS_PATH, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== "lucide-react") continue;
    for (const specifier of statement.importClause?.namedBindings?.elements ?? []) {
      if (!["AlertTriangle", "CircleDollarSign", "FileClock"].includes(specifier.name.text)) continue;
      if (identifierCount(source, specifier.name.text) === 1) findings.push(specifier.name.text);
    }
  }

  let drawer;
  function findDrawer(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "RenewalDrawer") drawer = node;
    ts.forEachChild(node, findDrawer);
  }
  findDrawer(source);
  assert.ok(drawer, "RenewalDrawer declaration must exist in the unfixed baseline");
  assert.equal(identifierCount(drawer, "onClose"), 2, "onClose should occur only in the binding and inline prop type");
  findings.push("RenewalDrawer.onClose");

  return findings.filter((name) => isBugCondition(completeSubject()));
}

// **Validates: Requirements 1.2, 1.3, 2.1, 2.2, 2.3**
test("Property 1 exhaustively classifies every deterministic consumer combination", () => {
  const combinationCount = 2 ** CONSUMER_CLASSES.length;
  for (let mask = 0; mask < combinationCount; mask += 1) {
    const consumers = Object.fromEntries(
      CONSUMER_CLASSES.map((consumerClass, index) => [
        consumerClass,
        mask & (1 << index) ? [`fixture:${consumerClass}`] : [],
      ]),
    );
    assert.equal(
      isBugCondition(completeSubject(consumers)),
      mask === 0,
      `mask ${mask.toString(2).padStart(CONSUMER_CLASSES.length, "0")} was misclassified`,
    );
  }
});

// **Validates: Requirements 2.2, 2.3, 2.5, 2.8**
test("Property 1 rejects incomplete, uncertain, side-effectful, external, and non-retained evidence", () => {
  const preserved = [
    completeSubject({}, { complete: false }),
    completeSubject({}, { uncertain: true }),
    completeSubject({}, { requiredSideEffects: ["registration"] }),
    completeSubject({}, { applicable: CONSUMER_CLASSES.filter((name) => name !== "external") }),
    completeSubject({ external: ["plausible external caller"] }),
    { ...completeSubject(), repositoryMaintained: false },
    { ...completeSubject(), retained: false },
  ];
  for (const subject of preserved) assert.equal(isBugCondition(subject), false);
});

// **Validates: Requirements 2.2, 2.3, 2.5**
test("Property 1 protects framework, type-only, dynamic, configuration, environment, script, integration, and operational consumers", () => {
  for (const consumerClass of CONSUMER_CLASSES) {
    assert.equal(
      isBugCondition(completeSubject({ [consumerClass]: [`fixture:${consumerClass}`] })),
      false,
      `${consumerClass} consumers must force preservation`,
    );
  }
});

// Bug-condition exploration: failure is expected on F and proves retained counterexamples exist.
// **Validates: Requirements 1.1, 1.7, 1.8, 2.1, 2.7, 2.8**
test("Property 1 exploration finds no retained proven-unused RenewalsPage declarations", async () => {
  const counterexamples = await retainedRenewalsCounterexamples();
  assert.deepEqual(counterexamples, []);
});
