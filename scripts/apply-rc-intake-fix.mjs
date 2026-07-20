#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const apiPath = path.join(root, 'src/features/cs-intake/api.ts');
const queuePath = path.join(root, 'src/features/cs-intake/IntakeQueue.tsx');
const quotesApiPath = path.join(root, 'src/features/quotes/api.ts');

function readRequired(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required file not found: ${path.relative(root, filePath)}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function writeChanged(filePath, before, after) {
  if (before === after) {
    console.log(`No changes needed: ${path.relative(root, filePath)}`);
    return;
  }
  fs.writeFileSync(filePath, after, 'utf8');
  console.log(`Updated: ${path.relative(root, filePath)}`);
}

function replaceOnce(text, search, replacement, label) {
  const index = text.indexOf(search);
  if (index === -1) {
    throw new Error(`Could not find expected code for: ${label}`);
  }
  if (text.indexOf(search, index + search.length) !== -1) {
    throw new Error(`Expected one match but found multiple for: ${label}`);
  }
  return text.slice(0, index) + replacement + text.slice(index + search.length);
}

function replaceRegexOnce(text, regex, replacement, label) {
  const matches = [...text.matchAll(new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`))];
  if (matches.length !== 1) {
    throw new Error(`Expected one match for ${label}, found ${matches.length}.`);
  }
  return text.replace(regex, replacement);
}

// ---------------------------------------------------------------------------
// 1. Legacy CS intake API: expose the correct atomic RPC and source field.
// ---------------------------------------------------------------------------
{
  const before = readRequired(apiPath);
  let after = before;

  if (!after.includes("intake_channel?: 'ringcentral' | 'manual';")) {
    after = replaceOnce(
      after,
      '  quote_kind: QuoteKind;\n',
      "  quote_kind: QuoteKind;\n  intake_channel?: 'ringcentral' | 'manual';\n",
      'CsIntakeSubmission.intake_channel',
    );
  }

  if (!after.includes('export async function claimRingcentralQueueIntake')) {
    const marker = 'export async function managerAssignIntake';
    const fn = `export async function claimRingcentralQueueIntake(id: string): Promise<string> {\n  const { data, error } = await getSupabase().rpc('cs_intake_claim_ringcentral', {\n    p_submission_id: id,\n  });\n  throwIfError(error);\n  return data as string;\n}\n\n`;
    after = replaceOnce(after, marker, `${fn}${marker}`, 'atomic RingCentral queue API');
  }

  writeChanged(apiPath, before, after);
}

// ---------------------------------------------------------------------------
// 2. Agent Intake Queue: stop mixing the legacy queue with the v1 customer-
//    intakes RPC, stop inferring RC from work_item_id, and use one-click flow.
// ---------------------------------------------------------------------------
{
  const before = readRequired(queuePath);
  let after = before;

  after = after.replace(
    /^import \{ claimRingcentralIntake \} from '\.\.\/quotes\/api';\r?\n/m,
    '',
  );

  if (!after.includes('claimRingcentralQueueIntake,')) {
    after = replaceRegexOnce(
      after,
      /(import \{\s*\r?\n\s*claimIntake,)/,
      `$1\n  claimRingcentralQueueIntake,`,
      'cs-intake API import',
    );
  }

  after = replaceOnce(
    after,
    'const canClaimRc = isCurrentRcAgent || isManager;',
    'const canClaimRc = isCurrentRcAgent;',
    'only the current RingCentral agent may claim',
  );

  after = replaceOnce(
    after,
    'await claimRingcentralIntake(row.id);',
    'await claimRingcentralQueueIntake(row.id);',
    'correct legacy queue claim RPC',
  );

  after = after.replace(
    'RingCentral intake claimed. Your quote has been created.',
    'RingCentral intake claimed. Your active quote was created and the turn advanced.',
  );

  after = replaceRegexOnce(
    after,
    /function isRingcentralSource\(row: CsIntakeSubmission\): boolean \{[\s\S]*?return Boolean\(row\.work_item_id\);\s*\}/,
    `function isRingcentralSource(row: CsIntakeSubmission): boolean {\n    // Legacy Customer Service submissions are RingCentral queue items by default.\n    // Manager-assigned records are explicitly marked as manual by the migration.\n    return row.intake_channel !== 'manual';\n  }`,
    'RingCentral source detection',
  );

  if (!after.includes('async function handleCreateQuote(row: CsIntakeSubmission)')) {
    const marker = 'async function assign(row: CsIntakeSubmission, agentId: string) {';
    const fn = `  async function handleCreateQuote(row: CsIntakeSubmission) {\n    if (isRingcentralSource(row) && row.claimed_by === profile.id) {\n      await handleClaimRc(row);\n      return;\n    }\n\n    await action(\n      row.id,\n      () => convertIntake(row.id),\n      'Quote created in the Work Desk.',\n    );\n  }\n\n`;
    after = replaceOnce(after, marker, `${fn}  ${marker}`, 'claimed-row recovery handler');
  }

  const rowConvertRegex = /void action\(\s*row\.id,\s*async \(\) => \{\s*await convertIntake\(row\.id\);\s*\},\s*'Quote created in Quotes Database\.',?\s*\)/g;
  const selectedConvertRegex = /void action\(\s*selected\.submission\.id,\s*async \(\) => \{\s*await convertIntake\(selected\.submission\.id\);\s*\},\s*'Quote created in Quotes Database\.',?\s*\)/g;

  after = after.replace(rowConvertRegex, 'void handleCreateQuote(row)');
  after = after.replace(selectedConvertRegex, 'void handleCreateQuote(selected.submission)');

  if (after.includes('await convertIntake(row.id);') || after.includes('await convertIntake(selected.submission.id);')) {
    throw new Error('One or more old inline Create Quote handlers were not replaced.');
  }

  writeChanged(queuePath, before, after);
}

// ---------------------------------------------------------------------------
// 3. Correct the v1 operational-quotes API return type. Its SQL RPC returns a
//    UUID, not an object. This is separate from the legacy queue but removes a
//    real type mismatch found during the repository review.
// ---------------------------------------------------------------------------
{
  const before = readRequired(quotesApiPath);
  let after = before;

  after = after.replace(
    "export async function claimRingcentralIntake(intakeId: string): Promise<{ quote_id: string }> {",
    'export async function claimRingcentralIntake(intakeId: string): Promise<string> {',
  );
  after = after.replace(
    'return data as { quote_id: string };',
    'return data as string;',
  );

  writeChanged(quotesApiPath, before, after);
}

console.log('\nRingCentral intake source changes applied successfully.');
console.log('Next: copy/run the SQL migration, then run npm run lint and npm run build.');
