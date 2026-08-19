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
const templateFile = 'C:/Users/landa/Downloads/Generic_Truck_Application_Fillable.pdf';
const storagePath = 'templates/generic-truck-application-blank.pdf';

const carriers = [
  'Commonwealth Underwriters',
  'Eastern Underwriting Managers',
  'All Star Underwriters',
];

async function main() {
  const fileBuffer = readFileSync(templateFile);
  console.log(`Uploading Generic Truck Application (${fileBuffer.length} bytes)...`);

  const { error: uploadError } = await supabase.storage
    .from('specialty-quote-documents')
    .upload(storagePath, fileBuffer, { contentType: 'application/pdf', upsert: true });

  if (uploadError) { console.error('Upload failed:', uploadError.message); process.exit(1); }
  console.log('Upload successful!');

  // Create template records for each carrier
  for (const carrierName of carriers) {
    const { data: market } = await supabase
      .from('market_directory')
      .select('id')
      .eq('name', carrierName)
      .single();

    if (!market) {
      console.error(`Market "${carrierName}" not found — skipping`);
      continue;
    }

    const { error: insertError, data } = await supabase
      .from('market_pdf_templates')
      .upsert({
        market_id: market.id,
        line_of_business: 'trucking',
        template_name: 'Generic Truck Application',
        version_label: '1.0',
        is_active: true,
        storage_path: storagePath,
        storage_bucket: 'specialty-quote-documents',
        field_mapping: {},
        max_drivers: 5,
        max_vehicles: 5,
        max_trailers: 5,
      }, { onConflict: 'market_id,line_of_business,template_name,version_label' })
      .select('id, template_name, storage_path');

    if (insertError) {
      console.error(`Failed for ${carrierName}:`, insertError.message);
    } else {
      console.log(`✓ ${carrierName}:`, data);
    }
  }

  console.log('\nDone!');
}

main().catch(console.error);
