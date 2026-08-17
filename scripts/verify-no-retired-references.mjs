/**
 * Retired-reference scan for the Time & Attendance redesign.
 *
 * Spec: .kiro/specs/time-attendance-ui-redesign, task 24.1
 * Requirement 23, criterion 6: an obsolete component, route, or navigation
 * identifier is removed only after confirming that no remaining reference to
 * that item exists.
 *
 * The design names this check directly: "no source file references
 * `TimeClock`, `PTORequests`, `StaffingCoverage`, `AttendanceReports`,
 * `ta_clock`, `ta_pto`, `ta_staffing`, `ta_reports`, `/api/staffing`, or
 * `/api/time-clock/reports` after the cleanup commit".
 *
 * This script is read-only. It reads source files, writes nothing, and touches
 * no network or database.
 *
 * Usage:
 *
 *   npm run verify-no-retired-references
 *   npm run verify-no-retired-references -- --json
 *   npm run verify-no-retired-references -- --raw
 *
 * Flags:
 *   --raw     scan every source file including this one, and include comment
 *             prose. This is the unfiltered view: what the repository contains
 *             before any judgement about what is allowed to contain it. Useful
 *             for auditing the exclusion below.
 *   --json    emit the findings as JSON on stdout instead of the report
 *   --quiet   print the verdict and the hits, and omit the scan summary
 *
 * Exit codes: 0 when every target is clean, 1 on any hit or any read failure.
 *
 * ## What counts as a reference
 *
 * Comment prose does not. Several surviving modules explain themselves by
 * naming the screen they replace — `useAsyncResource.ts` says the legacy
 * screens each held their own `loading` flag, `domain/pto.ts` says
 * `PTORequests.tsx` held one of the two `countWeekdays` copies — and that
 * history is the reason those modules are shaped the way they are. Deleting the
 * explanation to satisfy a grep would cost more than it buys. So comments are
 * blanked out before the patterns run.
 *
 * Everything else is scanned as code, including string literals, template
 * literals, JSX text, and regex bodies. A retired route named in a `fetch` call
 * is exactly the reference this check exists to catch, and it lives in a string.
 *
 * One known gap: a route written inside a regular-expression literal escapes its
 * slashes — `/\/api\/staffing/` — and the path patterns below match the plain
 * form, so that spelling is not caught. Left alone rather than papered over,
 * because a pattern loose enough to match the escaped form would also match
 * unrelated text, and no route in this repository is referenced that way.
 *
 * ## Exclusions, and why the last one is here
 *
 * One path is excluded, listed in `EXEMPT_PATHS` with the reason attached:
 * **this script**, which names all ten targets by construction.
 *
 * Every other exemption has expired. Each deletion target documented itself —
 * `TimeClock.tsx` carried its own name, `src/app/api/staffing/route.ts`
 * documented the route it served — so each was exempt right up to the commit
 * that removed the file, because scanning it would have reported the deletion
 * target as a blocker for its own deletion. Task 24.2 deleted the four
 * components and task 24.3 the two routes; those six entries are gone, and all
 * six of those targets now report clean with nothing exempt.
 *
 * Nothing else is excluded, and nothing else needs to be. Task 24.4 removed the
 * last four targets — the retired navigation identifiers held by
 * `app-sidebar.tsx`'s `SubNavId` union and by the section map in
 * `shared/navigation-target.ts` — so all ten now report clean with only this
 * file exempt.
 *
 * ## Precision
 *
 * Every pattern is case-sensitive and anchored, because the plain substrings
 * would each catch live code:
 *
 * - `TimeClock` as a bare substring matches `TimeClockEntry` and
 *   `TimeClockBreak`, the two row types in `features/time-attendance/types.ts`
 *   that describe the preserved `time_clock_entries` and `time_clock_breaks`
 *   tables. Case-insensitively it also matches `time_clock_entries` itself.
 * - `PTORequests` case-insensitively matches `PTORequestSourceRow`, the row type
 *   `server/pto-service.ts` reads `pto_requests` into.
 * - `/api/staffing` is a prefix of any future `/api/staffing-*` route, and
 *   `/api/time-clock/reports` sits under `/api/time-clock`, which is the
 *   preserved clock endpoint and must not be flagged.
 *
 * Each entry in `TARGETS` records what its pattern matches and what it
 * deliberately does not.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

/**
 * Where source code lives.
 *
 * `src` is the application. `scripts` is here because a verification script
 * that fetched a retired route would be just as broken as a component that did,
 * and because this file lives there.
 *
 * `supabase` is deliberately absent. Released migration files must stay
 * unmodified (Requirement 23, criterion 2), so a retired name mentioned in a
 * migration comment is a historical record that cannot be edited — reporting it
 * would produce a finding with no legal fix. `.kiro` is absent for the same
 * reason in reverse: the spec documents name the retired items on purpose.
 */
const SCAN_ROOTS = ['src', 'scripts'];

/** File extensions treated as source. */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
]);

/** Directory names never descended into. */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.next',
  '.git',
  '.turbo',
  'dist',
  'build',
  'coverage',
]);

/**
 * Paths the scan skips, each with the reason and the sub-task that ends the
 * exemption. Matched as exact paths or as directory prefixes, in repo-relative
 * posix form.
 *
 * Only the self-exemption is left, and it never expires. The six entries that
 * covered the deletion targets themselves expired with tasks 24.2 and 24.3.
 */
const EXEMPT_PATHS = [
  {
    path: 'scripts/verify-no-retired-references.mjs',
    reason: 'this script names every target by construction',
    endsWith: 'never',
  },
  {
    path: 'src/components/app-sidebar.tsx',
    reason:
      'holds RETIRED_SUBNAV_ALIASES, which must name the retired quote identifiers in order to resolve a stored navigation state that still uses one. Naming them there is the replacement, not a leftover reference.',
    endsWith: 'never',
  },
  {
    path: 'src/components/__tests__/retired-quote-navigation.test.ts',
    reason:
      'asserts that each retired quote identifier resolves to its replacement, which requires naming them.',
    endsWith: 'never',
  },
];

/**
 * The ten targets, grouped by the sub-task that clears them.
 *
 * `group` drives the verdict: `component` and `route` targets gate 24.2 and
 * 24.3, `navigation` targets gate 24.4. `matches` and `ignores` are printed
 * with any hit so a reader can judge the pattern rather than trust it.
 */
const TARGETS = [
  {
    id: 'TimeClock',
    group: 'component',
    clearedBy: '24.2',
    // `TimeClock` not followed by `Entry` or `Break`. The word boundary at the
    // front keeps `MyTimeClock` out; the negative lookahead keeps the two live
    // row types out while still catching `TimeClock`, `TimeClock.tsx`,
    // `<TimeClock`, and `TimeClockProps`.
    pattern: /\bTimeClock(?!Entry|Break)/g,
    matches: 'the retired component: TimeClock, TimeClock.tsx, <TimeClock, TimeClockProps',
    ignores:
      'TimeClockEntry and TimeClockBreak (live row types), time_clock_entries, /api/time-clock',
  },
  {
    id: 'PTORequests',
    group: 'component',
    clearedBy: '24.2',
    // Case-sensitive, so the capital S in `PTORequestSourceRow` is not a match.
    // No trailing boundary, so `PTORequestsProps` is caught too.
    pattern: /\bPTORequests/g,
    matches: 'the retired component: PTORequests, PTORequests.tsx, <PTORequests, PTORequestsProps',
    ignores: 'PTORequestSourceRow and PTORequestState (live types), pto_requests',
  },
  {
    id: 'StaffingCoverage',
    group: 'component',
    clearedBy: '24.2',
    pattern: /\bStaffingCoverage/g,
    matches: 'the retired component: StaffingCoverage, StaffingCoverage.tsx, <StaffingCoverage',
    ignores: 'staffing_thresholds, CoverageBadge, coverage-service, projectCoverage, liveCoverage',
  },
  {
    id: 'AttendanceReports',
    group: 'component',
    clearedBy: '24.2',
    pattern: /\bAttendanceReports/g,
    matches: 'the retired component: AttendanceReports, AttendanceReports.tsx, <AttendanceReports',
    ignores: 'AttendanceReport (singular), attendance_* tables, ReviewCenter',
  },
  {
    id: 'ta_clock',
    group: 'navigation',
    clearedBy: '24.4',
    pattern: /\bta_clock\b/g,
    matches: 'the retired sub-navigation identifier, replaced by ta_today',
    ignores: 'ta_today, time_clock_entries, clockStatus',
  },
  {
    id: 'ta_pto',
    group: 'navigation',
    clearedBy: '24.4',
    pattern: /\bta_pto\b/g,
    matches: 'the retired sub-navigation identifier, replaced by ta_timeoff',
    ignores: 'ta_timeoff, ta_payroll, pto_requests, PTO_TYPE_TO_BALANCE_FIELD',
  },
  {
    id: 'ta_staffing',
    group: 'navigation',
    clearedBy: '24.4',
    pattern: /\bta_staffing\b/g,
    matches: 'the retired sub-navigation identifier, which has no replacement screen',
    ignores: 'staffing_thresholds',
  },
  {
    id: 'ta_reports',
    group: 'navigation',
    clearedBy: '24.4',
    pattern: /\bta_reports\b/g,
    matches: 'the retired sub-navigation identifier, replaced by ta_review',
    ignores: 'ta_review, commercial_reports, sales_performance',
  },
  {
    id: '/api/staffing',
    group: 'route',
    clearedBy: '24.3',
    // The lookahead stops the pattern claiming a longer route that merely
    // starts with the same path.
    pattern: /\/api\/staffing(?![\w-])/g,
    matches: 'the retired route: /api/staffing and any query string on it',
    ignores: '/api/staffing-anything, /api/coverage (its replacement)',
  },
  {
    id: '/api/time-clock/reports',
    group: 'route',
    clearedBy: '24.3',
    pattern: /\/api\/time-clock\/reports(?![\w-])/g,
    matches: 'the retired route: /api/time-clock/reports and any query string on it',
    ignores:
      '/api/time-clock, /api/time-clock/breaks, /api/time-clock/entries (all preserved), /api/attendance/records (its replacement)',
  },

  // ── Quote Center consolidation ────────────────────────────────────────────
  //
  // Five sub-navigation identifiers were retired when the four overlapping quote
  // lookup screens collapsed into Quote Center and My Desk. Each is still
  // recognised at runtime by RETIRED_SUBNAV_ALIASES in app-sidebar.tsx, which is
  // deliberate — a user's stored navigation state may still name one — but no
  // source file should be *offering* them any more.
  //
  // The aliases themselves are the one legitimate remaining use, so
  // `app-sidebar.tsx` is exempt below for exactly the reason the deletion targets
  // were: it is the file whose job is to name them.
  {
    id: 'sales_databases',
    group: 'quote-navigation',
    clearedBy: 'quote-center',
    pattern: /\bsales_databases\b/g,
    matches: 'the retired Databases screen identifier, replaced by quote_center',
    ignores: 'quote_center, commercial_database, sales_desk',
  },
  {
    id: 'sales_pricing',
    group: 'quote-navigation',
    clearedBy: 'quote-center',
    pattern: /\bsales_pricing\b/g,
    matches:
      'the retired Pending Pricing screen identifier, replaced by the pricing section of My Desk',
    ignores: 'pending_pricing_quotes, priceSentAt, sales_desk',
  },
  {
    id: 'sales_intake_queue',
    group: 'quote-navigation',
    clearedBy: 'quote-center',
    pattern: /\bsales_intake_queue\b/g,
    matches:
      'the retired Intake Queue screen identifier, replaced by the intake section of My Desk',
    ignores: 'IntakeQueue (the component, which is still rendered), cs_intake_submissions',
  },
  {
    id: 'sales_team',
    group: 'quote-navigation',
    clearedBy: 'quote-center',
    pattern: /\bsales_team\b/g,
    matches: 'the retired My Team screen identifier, replaced by sales_performance',
    ignores: 'MyTeamPanel (the component, now rendered under Performance), TeamPerformanceTable',
  },
  {
    id: 'cs_queue',
    group: 'quote-navigation',
    clearedBy: 'quote-center',
    pattern: /\bcs_queue\b/g,
    matches:
      'the retired Customer Service Sales Queue identifier, which rendered the same IntakeQueue component as sales_intake_queue',
    ignores: 'cs_intakes (retained for commercial roles), cs_intake_submissions',
  },
];

/** How each group is described in the verdict. */
const GROUP_LABEL = {
  component: 'Superseded components (gate for task 24.2)',
  route: 'Superseded routes (gate for task 24.3)',
  navigation: 'Retired navigation identifiers (gate for task 24.4)',
  'quote-navigation': 'Retired quote lookup identifiers (gate for the Quote Center consolidation)',
};

const GROUP_ORDER = ['component', 'route', 'navigation', 'quote-navigation'];

// ─── Comment blanking ────────────────────────────────────────────────────────

/**
 * Characters after which a `/` opens a regular-expression literal rather than
 * dividing. Only the previous significant character is consulted, which is
 * enough for every regex in this repository.
 */
const REGEX_MAY_FOLLOW = new Set([
  '',
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
  '\n',
]);

/** Keywords after which a `/` opens a regular-expression literal. */
const REGEX_MAY_FOLLOW_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * The source with every comment replaced by spaces, same length, same line
 * breaks, so a match index still maps to its original line and column.
 *
 * A single pass that knows the four things a `/` can begin — a line comment, a
 * block comment, a regex literal, or a division — and the three quoting forms,
 * including `${}` substitutions nested inside template literals to any depth.
 * Without the regex case, a pattern such as `/https?:\/\//` would end in two
 * slashes that read as a line comment and blank the rest of the line, which is
 * the one failure mode a check like this cannot afford: a silent false negative.
 */
export function blankComments(source) {
  const out = source.split('');
  const n = source.length;

  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };

  // A stack of frames so `` `a ${ `b ${c}` } d` `` is tracked correctly.
  const frames = [{ kind: 'code', braceDepth: 0 }];
  let previousChar = '';
  let previousWord = '';
  let i = 0;

  while (i < n) {
    const frame = frames[frames.length - 1];
    const c = source[i];

    if (frame.kind === 'template') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        frames.pop();
        previousChar = '`';
        previousWord = '';
        i += 1;
        continue;
      }
      if (c === '$' && source[i + 1] === '{') {
        frames.push({ kind: 'code', braceDepth: 0 });
        previousChar = '';
        previousWord = '';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    // Line comment. Checked before the regex case because no valid regex
    // literal begins with a second slash, and because JSX writes `{/* … */}`.
    if (c === '/' && source[i + 1] === '/') {
      let j = i + 2;
      while (j < n && source[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }

    // Block comment. Unterminated runs to end of file, which is what a compiler
    // would see too.
    if (c === '/' && source[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j += 1;
      const end = Math.min(n, j + 2);
      blank(i, end);
      i = end;
      continue;
    }

    if (
      c === '/' &&
      (REGEX_MAY_FOLLOW.has(previousChar) || REGEX_MAY_FOLLOW_WORD.has(previousWord))
    ) {
      let j = i + 1;
      let inCharacterClass = false;
      let closed = false;
      while (j < n) {
        const e = source[j];
        if (e === '\\') {
          j += 2;
          continue;
        }
        if (e === '\n') break; // Not a regex literal after all; leave it as code.
        if (e === '[') inCharacterClass = true;
        else if (e === ']') inCharacterClass = false;
        else if (e === '/' && !inCharacterClass) {
          j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      // The body stays in place: a retired route written inside a regex is a
      // reference to it.
      i = closed ? j : i + 1;
      previousChar = '/';
      previousWord = '';
      continue;
    }

    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === c || source[j] === '\n') {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      previousChar = c;
      previousWord = '';
      continue;
    }

    if (c === '`') {
      frames.push({ kind: 'template' });
      i += 1;
      continue;
    }

    if (c === '{') {
      frame.braceDepth += 1;
    } else if (c === '}') {
      if (frame.braceDepth === 0 && frames.length > 1) {
        frames.pop(); // End of a `${…}` substitution.
        previousChar = '}';
        previousWord = '';
        i += 1;
        continue;
      }
      frame.braceDepth = Math.max(0, frame.braceDepth - 1);
    }

    if (/[A-Za-z0-9_$]/.test(c)) {
      previousWord = /[A-Za-z0-9_$]/.test(previousChar) ? previousWord + c : c;
    } else if (!/\s/.test(c)) {
      previousWord = '';
    }
    if (!/[ \t\r]/.test(c)) previousChar = c;
    i += 1;
  }

  return out.join('');
}

// ─── Scanning ────────────────────────────────────────────────────────────────

/** Repo-relative posix path, which is what the report and the exemptions use. */
function relativePosix(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join('/');
}

/** Whether `relPath` is an exempt file or sits under an exempt directory. */
function exemptionFor(relPath) {
  return (
    EXEMPT_PATHS.find(
      (entry) => relPath === entry.path || relPath.startsWith(`${entry.path}/`),
    ) ?? null
  );
}

/** Every source file under `roots`, depth first, in a stable order. */
async function collectSourceFiles(roots) {
  const found = [];

  async function walk(absoluteDir) {
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`cannot read ${relativePosix(absoluteDir)}: ${error.message}`);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        await walk(absolute);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        found.push(absolute);
      }
    }
  }

  for (const root of roots) {
    const absoluteRoot = path.join(REPO_ROOT, root);
    let info;
    try {
      info = await stat(absoluteRoot);
    } catch {
      throw new Error(`scan root ${root} does not exist`);
    }
    if (!info.isDirectory()) throw new Error(`scan root ${root} is not a directory`);
    await walk(absoluteRoot);
  }

  return found;
}

/** Offsets at which each line starts, for turning a match index into line:column. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** The 1-based line and column of `index`. */
function positionOf(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: index - starts[low] + 1 };
}

/**
 * Every hit in one file.
 *
 * The patterns run against the comment-blanked text but the reported source
 * line comes from the original, so the report shows what the file actually says.
 */
function scanSource(relPath, source, { includeComments }) {
  const scanned = includeComments ? source : blankComments(source);
  const starts = lineStarts(source);
  const rawLines = source.split('\n');
  const hits = [];

  for (const target of TARGETS) {
    target.pattern.lastIndex = 0;
    let match;
    while ((match = target.pattern.exec(scanned)) !== null) {
      const { line, column } = positionOf(starts, match.index);
      hits.push({
        target: target.id,
        group: target.group,
        clearedBy: target.clearedBy,
        file: relPath,
        line,
        column,
        text: (rawLines[line - 1] ?? '').trim(),
      });
      if (match[0].length === 0) target.pattern.lastIndex += 1;
    }
  }

  return hits;
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { json: false, raw: false, quiet: false };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--raw') options.raw = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown flag ${arg}`);
  }
  return options;
}

const USAGE = `Retired-reference scan (spec time-attendance-ui-redesign, task 24.1)

  node scripts/verify-no-retired-references.mjs [--raw] [--json] [--quiet]

  --raw    include the files pending deletion and comment prose
  --json   emit findings as JSON
  --quiet  omit the scan summary`;

function printReport(result, options) {
  const { scannedCount, exemptCount, hits, raw } = result;

  console.log('Retired-reference scan — spec time-attendance-ui-redesign, task 24.1');
  console.log('Requirement 23, criterion 6: remove nothing while a reference to it remains.');
  console.log('');

  if (!options.quiet) {
    console.log(`Scanned ${scannedCount} source file(s) under ${SCAN_ROOTS.join(', ')}.`);
    if (raw) {
      console.log('Mode: raw. No path exempt, comment prose included.');
    } else {
      console.log(`Skipped ${exemptCount} exempt path(s):`);
      for (const entry of EXEMPT_PATHS) {
        console.log(`  ${entry.path}`);
        console.log(`      ${entry.reason}`);
      }
      console.log('Comment prose excluded. Strings, template literals, JSX text, and');
      console.log('regex bodies are scanned as code.');
    }
    console.log('');
  }

  for (const group of GROUP_ORDER) {
    const targets = TARGETS.filter((target) => target.group === group);
    if (targets.length === 0) continue;
    console.log(GROUP_LABEL[group]);
    for (const target of targets) {
      const found = hits.filter((hit) => hit.target === target.id);
      const label = target.id.padEnd(24);
      if (found.length === 0) {
        console.log(`  ${label} clean`);
        continue;
      }
      console.log(`  ${label} ${found.length} reference(s)`);
      console.log(`      pattern matches: ${target.matches}`);
      console.log(`      pattern ignores: ${target.ignores}`);
      for (const hit of found) {
        console.log(`      ${hit.file}:${hit.line}:${hit.column}`);
        console.log(`          ${hit.text}`);
      }
    }
    console.log('');
  }

  if (hits.length === 0) {
    console.log('Verdict: clean. No source file references any retired component, route, or');
    console.log('navigation identifier.');
    return;
  }

  console.log(`Verdict: ${hits.length} reference(s) remain.`);
  const byTask = new Map();
  for (const hit of hits) {
    byTask.set(hit.clearedBy, (byTask.get(hit.clearedBy) ?? 0) + 1);
  }
  for (const task of [...byTask.keys()].sort()) {
    console.log(`  ${byTask.get(task)} cleared by task ${task}`);
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function runScan({ includeComments = false, includeExempt = false } = {}) {
  const files = await collectSourceFiles(SCAN_ROOTS);
  const hits = [];
  let scannedCount = 0;
  let exemptCount = 0;

  for (const absolute of files) {
    const relPath = relativePosix(absolute);
    if (!includeExempt && exemptionFor(relPath) !== null) {
      exemptCount += 1;
      continue;
    }
    scannedCount += 1;
    let source;
    try {
      source = await readFile(absolute, 'utf8');
    } catch (error) {
      throw new Error(`cannot read ${relPath}: ${error.message}`);
    }
    hits.push(...scanSource(relPath, source, { includeComments }));
  }

  hits.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      a.target.localeCompare(b.target) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column,
  );

  return { scannedCount, exemptCount, hits };
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(USAGE);
    return 1;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  let result;
  try {
    result = await runScan({ includeComments: options.raw, includeExempt: options.raw });
  } catch (error) {
    console.error(`Retired-reference scan failed: ${error.message}`);
    return 1;
  }

  const report = { ...result, raw: options.raw };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, options);
  }

  return report.hits.length === 0 ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) process.exitCode = await main(process.argv.slice(2));
