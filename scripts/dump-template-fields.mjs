/**
 * Dumps the AcroForm field names of every blank carrier template registered in
 * market_pdf_templates. Read-only: downloads from storage, enumerates fields,
 * prints them. Nothing is written back.
 *
 * Run:  node scripts/dump-template-fields.mjs [filterSubstring]
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PDFDocument } from 'pdf-lib';

const envPath = resolve(import.meta.dirname, '..', '.env.local');
const env = {};
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY,
);

const filter = (process.argv[2] || '').toLowerCase();

const { data: templates, error } = await supabase
  .from('market_pdf_templates')
  .select('id, template_name, storage_bucket, storage_path, max_drivers, max_vehicles, max_trailers, market_directory(name)')
  .order('template_name');

if (error) {
  console.error('Query failed:', error.message);
  process.exit(1);
}

for (const template of templates ?? []) {
  const marketName = template.market_directory?.name ?? '(no market)';
  const label = `${marketName} :: ${template.template_name}`;
  if (filter && !label.toLowerCase().includes(filter)) continue;

  console.log('\n' + '='.repeat(78));
  console.log(label);
  console.log(`  max drivers=${template.max_drivers} vehicles=${template.max_vehicles} trailers=${template.max_trailers}`);
  console.log(`  storage_path=${template.storage_path ?? 'NULL (falls back to structured summary)'}`);

  if (!template.storage_path) continue;

  const { data: file, error: downloadError } = await supabase.storage
    .from(template.storage_bucket || 'specialty-quote-documents')
    .download(template.storage_path);

  if (downloadError || !file) {
    console.log(`  DOWNLOAD FAILED: ${downloadError?.message ?? 'no data'}`);
    continue;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let pdf;
  try {
    pdf = await PDFDocument.load(bytes);
  } catch (err) {
    console.log(`  LOAD FAILED: ${err.message}`);
    continue;
  }

  const fields = pdf.getForm().getFields();
  console.log(`  pages=${pdf.getPageCount()}  acroform fields=${fields.length}`);

  for (const field of fields) {
    const kind = field.constructor.name.replace('PDF', '');
    let extra = '';
    if (kind === 'RadioGroup' || kind === 'Dropdown' || kind === 'OptionList') {
      try {
        extra = `  options=[${field.getOptions().join(' | ')}]`;
      } catch { /* no options */ }
    }
    console.log(`    ${kind.padEnd(12)} ${JSON.stringify(field.getName())}${extra}`);
  }
}

console.log('\nDone.');
