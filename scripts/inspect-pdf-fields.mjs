/**
 * Inspect a PDF to list its AcroForm fields.
 * Usage: node scripts/inspect-pdf-fields.mjs <path-to-pdf>
 */
import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'fs';

const pdfPath = process.argv[2] || 'C:/Users/landa/Downloads/jsatruckoptima.pdf';
console.log(`Inspecting: ${pdfPath}`);

const bytes = readFileSync(pdfPath);
const pdfDoc = await PDFDocument.load(bytes);

const form = pdfDoc.getForm();
const fields = form.getFields();

console.log(`\nTotal form fields found: ${fields.length}`);

if (fields.length === 0) {
  console.log('This PDF has NO interactive form fields.');
  console.log('Text will need to be overlaid at specific x/y coordinates on each page.');
  
  const pages = pdfDoc.getPages();
  console.log(`\nPages: ${pages.length}`);
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const { width, height } = page.getSize();
    console.log(`  Page ${i + 1}: ${width} x ${height}`);
  }
} else {
  console.log('\nFields:');
  for (const field of fields) {
    const type = field.constructor.name;
    console.log(`  [${type}] "${field.getName()}"`);
  }
}
