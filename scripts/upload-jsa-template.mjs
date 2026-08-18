/**
 * Upload the official blank JSA Truck Application PDF to Supabase storage
 * and update the market_pdf_templates record with the storage path.
 */

import { createClient } from '@supabase/supabase-js';
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

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const templateFile = resolve('C:/Users/landa/Downloads/jsatruckoptima.pdf');
const storagePath = 'templates/jsa-truck-application-blank.pdf';
const bucketName = 'specialty-quote-documents';

async function main() {
  console.log('Reading template file...');
  const fileBuffer = readFileSync(templateFile);
  console.log(`File size: ${fileBuffer.length} bytes`);

  // Upload to storage
  console.log(`Uploading to ${bucketName}/${storagePath}...`);
  const { error: uploadError } = await supabase.storage
    .from(bucketName)
    .upload(storagePath, fileBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadError) {
    console.error('Upload failed:', uploadError.message);
    process.exit(1);
  }
  console.log('Upload successful!');

  // Update the template record
  console.log('Updating market_pdf_templates record...');
  const { data: market } = await supabase
    .from('market_directory')
    .select('id')
    .eq('name', 'JSA')
    .single();

  if (!market) {
    console.error('JSA market not found in market_directory');
    process.exit(1);
  }

  const { error: updateError, data: updated } = await supabase
    .from('market_pdf_templates')
    .update({
      storage_path: storagePath,
      storage_bucket: bucketName,
    })
    .eq('market_id', market.id)
    .eq('template_name', 'JSA Truck Application')
    .select('id, template_name, storage_path');

  if (updateError) {
    console.error('Update failed:', updateError.message);
    process.exit(1);
  }

  console.log('Done! Template updated:', updated);
}

main().catch(console.error);
