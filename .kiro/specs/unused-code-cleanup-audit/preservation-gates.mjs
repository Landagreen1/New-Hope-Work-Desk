import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_BASELINE, REPOSITORY_ROOT, compareToBaseline } from "./preservation-oracle.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const ansi = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function normalizeLintJson(rawOutput, root = REPOSITORY_ROOT) {
  const clean = rawOutput.replace(ansi, "");
  const jsonStart = clean.indexOf("[{");
  if (jsonStart < 0) throw new Error("ESLint JSON output was not found.");
  const reports = JSON.parse(clean.slice(jsonStart));
  const diagnostics = reports.flatMap((report) => report.messages.map((message) => ({
    file: path.relative(root, report.filePath).split(path.sep).join("/"),
    ruleId: message.ruleId,
    severity: message.severity,
    line: message.line,
    column: message.column,
    endLine: message.endLine ?? null,
    endColumn: message.endColumn ?? null,
    message: message.message,
  })));
  diagnostics.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {
    errors: diagnostics.filter((item) => item.severity === 2).length,
    warnings: diagnostics.filter((item) => item.severity === 1).length,
    fingerprint: createHash("sha256").update(JSON.stringify(diagnostics)).digest("hex"),
  };
}

export function normalizeUnusedDiagnostics(rawOutput) {
  const clean = rawOutput.replace(ansi, "");
  return clean.split(/\r?\n/)
    .map((line) => line.match(/^(.+?\.[cm]?[jt]sx?)(?::(\d+):(\d+)|\((\d+),(\d+)\)):?\s*(?:-\s*)?error\s+(TS\d+):\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      file: match[1].split("\\").join("/"),
      line: Number(match[2] ?? match[4]),
      column: Number(match[3] ?? match[5]),
      code: match[6],
      message: match[7].trim(),
    }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}

export function normalizeBuildOracle(rawOutput) {
  const clean = rawOutput.replace(ansi, "");
  const routes = [...clean.matchAll(/[┌├└]\s+([○ƒ])\s+(\/\S*)/g)].map((match) => ({
    marker: match[1],
    path: match[2],
  }));
  return {
    routes: routes.sort((a, b) => a.path.localeCompare(b.path)),
    proxy: /ƒ\s+Proxy \(Middleware\)/.test(clean) ? "Proxy (Middleware)" : null,
  };
}

function run(command, args) {
  const result = spawnSync([command, ...args].join(" "), {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    shell: true,
  });
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status ?? 1,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    error: result.error?.message ?? null,
  };
}

export async function runPreservationGates({ baselinePath = DEFAULT_BASELINE, allowedFiles = [] } = {}) {
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const contracts = await compareToBaseline(baselinePath);

  const lintHuman = run(npm, ["run", "lint"]);
  const lintMachine = run(npx, ["eslint", "--format", "json"]);
  const lint = normalizeLintJson(lintMachine.output);
  assert.equal(lintHuman.exitCode, baseline.validation.lint.exitCode, "lint exit code changed");
  assert.deepEqual(lint, baseline.validation.lint.normalized, "lint diagnostics changed");

  const strict = run(npx, ["tsc", "--noEmit"]);
  assert.equal(strict.exitCode, 0, `strict TypeScript failed:\n${strict.output}`);

  const unused = run(npx, ["tsc", "--noEmit", "--noUnusedLocals", "--noUnusedParameters", "--incremental", "false"]);
  assert.notEqual(unused.exitCode, 0, "audit-only unused probe unexpectedly passed");
  assert.deepEqual(normalizeUnusedDiagnostics(unused.output), baseline.validation.unused.diagnostics, "audit-only unused diagnostics changed");

  const build = run(npm, ["run", "build"]);
  assert.equal(build.exitCode, 0, `production build failed:\n${build.output}`);
  const buildOracle = normalizeBuildOracle(build.output);
  assert.deepEqual(
    buildOracle.routes,
    contracts.routes.map(({ marker, path: routePath }) => ({ marker, path: routePath })),
    "normalized build routes changed",
  );
  assert.equal(buildOracle.proxy, "Proxy (Middleware)", "proxy build contract changed");

  const diffCheck = run("git", ["diff", "--check"]);
  assert.equal(diffCheck.exitCode, 0, `git diff --check failed:\n${diffCheck.output}`);
  const changed = run("git", ["diff", "--name-only"]);
  assert.equal(changed.exitCode, 0, changed.output);
  const changedFiles = changed.output.trim().split(/\r?\n/).filter(Boolean).map((file) => file.split("\\").join("/"));
  const allowed = new Set(allowedFiles.map((file) => file.split("\\").join("/")));
  const unrelated = changedFiles.filter((file) => !allowed.has(file));
  assert.deepEqual(unrelated, [], `unapproved tracked files changed: ${unrelated.join(", ")}`);
  const protectedFiles = new Set(["package.json", "package-lock.json", "tsconfig.json", "eslint.config.mjs", "next.config.ts", ".npmrc"]);
  assert.deepEqual(changedFiles.filter((file) => protectedFiles.has(file)), [], "validation/dependency config changed");

  return {
    lint,
    strictExitCode: strict.exitCode,
    unusedDiagnostics: normalizeUnusedDiagnostics(unused.output),
    buildOracle,
    changedFiles,
  };
}

async function main() {
  const command = process.argv[2] ?? "--run";
  if (command === "--lint-observation") {
    const lint = run(npx, ["eslint", "--format", "json"]);
    console.log(JSON.stringify({ exitCode: lint.exitCode, normalized: normalizeLintJson(lint.output) }, null, 2));
    return;
  }
  if (command === "--run") {
    const allowArgument = process.argv.find((argument) => argument.startsWith("--allow="));
    const allowedFiles = allowArgument ? allowArgument.slice("--allow=".length).split(",").filter(Boolean) : [];
    const result = await runPreservationGates({ allowedFiles });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
