/**
 * Run a SQL file against the Supabase project using the Management API.
 * Usage: node scripts/run-sql.mjs <path-to-sql-file>
 *
 * Requires .env.local with:
 *   SUPABASE_ACCESS_TOKEN (personal access token from supabase.com/dashboard/account/tokens)
 *   SUPABASE_PROJECT_REF (project reference ID)
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local
const envPath = resolve(import.meta.dirname, '..', '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

const accessToken = env.SUPABASE_ACCESS_TOKEN;
const projectRef = env.SUPABASE_PROJECT_REF;

if (!accessToken || !projectRef) {
  console.error('Missing SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF in .env.local');
  process.exit(1);
}

const sqlFile = process.argv[2];
if (!sqlFile) {
  console.error('Usage: node scripts/run-sql.mjs <path-to-sql-file>');
  process.exit(1);
}

const sql = readFileSync(resolve(sqlFile), 'utf-8');

console.log(`Running SQL file: ${sqlFile}`);
console.log(`Project: ${projectRef}`);
console.log(`SQL length: ${sql.length} chars`);
console.log('---');

const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query: sql }),
  }
);

if (!response.ok) {
  const errText = await response.text();
  console.error(`Failed (${response.status}):`, errText);
  process.exit(1);
}

const result = await response.json();
console.log(JSON.stringify(result, null, 2));
