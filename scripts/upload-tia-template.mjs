import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(import.meta.dirname, '..', '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) env[match[1].trim()] = match[2].trim();
}

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY);
const templateFile = 'C:/Users/landa/Downloads/Quick-Quote-Form-editable (2) - TIA.pdf';
const storagePath = 'templates/tia-quick-quote-blank.pdf';

async function main() {
  const fileBuffer = readFileSync(templateFile);
  console.log(`Uploading TIA template (${fileBuffer.length} bytes)...`);

  const { error: uploadError } = await supabase.storage
    .from('specialty-quote-documents')
    .upload(storagePath, fileBuffer, { contentType: 'application/pdf', upsert: true });

  if (uploadError) { console.error('Upload failed:', uploadError.message); process.exit(1); }
  console.log('Upload successful!');

  const { data: market } = await supabase
    .from('market_directory')
    .select('id')
    .eq('name', 'Truckers Insurance Associates / TIA')
    .single();

  if (!market) { console.error('TIA market not found'); process.exit(1); }

  const { error: updateError, data } = await supabase
    .from('market_pdf_templates')
    .update({ storage_path: storagePath, storage_bucket: 'specialty-quote-documents' })
    .eq('market_id', market.id)
    .eq('template_name', 'TIA Quick Quote')
    .select('id, template_name, storage_path');

  if (updateError) { console.error('Update failed:', updateError.message); process.exit(1); }
  console.log('Done! Template updated:', data);
}

main().catch(console.error);
