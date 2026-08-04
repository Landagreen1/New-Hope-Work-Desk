/**
 * Read-only, local: extract the latest repo definition of each audited function,
 * write it beside the live dump, and report the normalized differences.
 *
 * Usage: node scripts/diff-live-vs-repo-functions.mjs
 * Touches no database.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

const root = resolve(import.meta.dirname, '..');
const evidence = join(root, '.kiro', 'specs', 'attendance-queue-status-separation', 'evidence');
const liveDir = join(evidence, 'live-functions');
const repoDir = join(evidence, 'repo-functions');
mkdirSync(repoDir, { recursive: true });

// name -> [{ file, startLine (1-based), label }]  — the latest repo definition(s) to compare
const sources = {
  set_my_availability: [
    { file: 'supabase/migrations/v1.8.7-fix-rotation-integrity.sql', startLine: 525, label: 'v1.8.7' },
    { file: 'supabase/schema.sql', startLine: 1754, label: 'schema.sql' },
  ],
  ensure_daily_availability_reset: [
    { file: 'supabase/schema.sql', startLine: 1712, label: 'schema.sql' },
    { file: 'supabase/migrations/v0.9.8-stabilize-integrations.sql', startLine: 1048, label: 'v0.9.8' },
  ],
  advance_rotation: [
    { file: 'supabase/migrations/v1.8.7-fix-rotation-integrity.sql', startLine: 277, label: 'v1.8.7' },
  ],
  ensure_rotation_valid: [
    { file: 'supabase/migrations/v1.8.7-fix-rotation-integrity.sql', startLine: 356, label: 'v1.8.7' },
  ],
  next_eligible_profile: [
    { file: 'supabase/migrations/v1.8.7-fix-rotation-integrity.sql', startLine: 97, label: 'v1.8.7' },
  ],
  is_rotation_eligible: [
    { file: 'supabase/migrations/v1.8.7-fix-rotation-integrity.sql', startLine: 151, label: 'v1.8.7' },
  ],
  is_agent: [{ file: 'supabase/schema.sql', startLine: 206, label: 'schema.sql' }],
  is_manager: [
    { file: 'supabase/migrations/v1.6.2-enforce-scoped-supervisor-access.sql', startLine: 7, label: 'v1.6.2' },
  ],
  can_manage_sales: [
    { file: 'supabase/migrations/v1.6.2-enforce-scoped-supervisor-access.sql', startLine: 22, label: 'v1.6.2' },
  ],
  manager_set_rotation_eligibility: [
    { file: 'supabase/migrations/v1.8.7-fix-rotation-integrity.sql', startLine: 632, label: 'v1.8.7' },
  ],
};

function extract(file, startLine) {
  const lines = readFileSync(join(root, file), 'utf-8').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let tag = null; // the opening dollar-quote tag, e.g. $$ or $daily_reset$
  for (let i = startLine - 1; i < lines.length; i += 1) {
    const line = lines[i];
    out.push(line);
    if (tag === null) {
      const open = line.match(/\bas\s+(\$[A-Za-z_]*\$)/i);
      if (open) {
        tag = open[1];
        // one-liner body: `as $$ select ... $$;`
        const rest = line.slice(line.indexOf(tag) + tag.length);
        if (rest.includes(tag)) break;
      }
      continue;
    }
    if (line.includes(tag)) break;
  }
  return out.join('\n');
}

// Normalization strips only cosmetics: CR, the dollar-quote tag, case,
// trailing whitespace, blank lines and SQL line comments.
function normalize(text) {
  return text
    .replace(/\r/g, '')
    .replace(/\$[A-Za-z_]*\$/g, '$$$$')
    .split('\n')
    .map((l) => l.replace(/--.*$/, '').replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .map((l) => l.trim().toLowerCase().replace(/\s+/g, ' '))
    .join('\n');
}

// Minimal LCS diff, enough to name the differing lines.
function diffLines(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${A[i]}`);
      i += 1;
    } else {
      out.push(`+ ${B[j]}`);
      j += 1;
    }
  }
  while (i < n) out.push(`- ${A[i++]}`);
  while (j < m) out.push(`+ ${B[j++]}`);
  return out;
}

const summary = [];
for (const [name, defs] of Object.entries(sources)) {
  const live = readFileSync(join(liveDir, `${name}.sql`), 'utf-8')
    .split('\n')
    .filter((l) => !l.startsWith('-- LIVE definition') && !l.startsWith('-- captured:') && !l.startsWith('-- function:') && !l.startsWith('-- language:') && !l.startsWith('-- READ-ONLY'))
    .join('\n');
  const liveNorm = normalize(live);

  for (const d of defs) {
    const repo = extract(d.file, d.startLine);
    const fileName = `${name}__${d.label.replace(/[^\w.-]/g, '_')}.sql`;
    writeFileSync(
      join(repoDir, fileName),
      `-- REPO definition extracted from ${d.file} line ${d.startLine}\n-- for comparison against the live dump in ../live-functions/${name}.sql\n\n${repo}\n`,
      'utf-8',
    );
    const repoNorm = normalize(repo);
    const diff = liveNorm === repoNorm ? [] : diffLines(liveNorm, repoNorm);
    const verdict = liveNorm === repoNorm ? 'IDENTICAL' : `DIFFERS (${diff.length} changed lines)`;
    summary.push({ name, repo_source: `${d.file}:${d.startLine}`, label: d.label, verdict, diff });
    console.log(`${name.padEnd(34)} vs ${d.label.padEnd(12)} ${verdict}`);
    if (diff.length && diff.length <= 60) diff.forEach((l) => console.log(`      ${l}`));
    else if (diff.length) console.log(`      (${diff.length} lines — see live-vs-repo-diff.json)`);
  }
}

writeFileSync(join(evidence, 'live-vs-repo-diff.json'), JSON.stringify({ captured_at: new Date().toISOString(), comparisons: summary }, null, 2), 'utf-8');
console.log(`\nwrote ${join(evidence, 'live-vs-repo-diff.json')}`);
