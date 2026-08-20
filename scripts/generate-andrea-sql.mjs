/**
 * generate-andrea-sql.mjs
 *
 * Parses Andrea Rueda's Trello CSV export and generates SQL INSERT statements
 * for manual execution in Supabase SQL editor.
 *
 * Usage: node scripts/generate-andrea-sql.mjs
 * Output: scripts/andrea-import.sql
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const CSV_PATH = "C:\\Users\\landa\\Downloads\\export (3)\\Export.csv";
const OUTPUT_PATH = resolve(process.cwd(), "scripts/andrea-import.sql");

// ─── Andrea's Board: List ID → board_column ──────────────────────────────────
const LIST_MAP = {
  "6a31601e49730c10da98fd47": "quoting",
  "6a31601a0e8e2994a5c5251c": "sold",
  "6a2982490b7f4ec83af197da": "quote_intake",
  "6a29777dbe61ef11223f8ceb": "quoting",
  "6a29777dbe61ef11223f8ce8": "quoting",
  "6a29777dbe61ef11223f8ce9": "not_sold",
};

// ─── Coverage detection ──────────────────────────────────────────────────────
function detectCoverage(name, desc) {
  const text = `${name} ${desc}`.toUpperCase();
  const glNo = /GL:\s*No/i.test(desc);
  const wcNo = /WC:\s*No/i.test(desc);
  const umbNo = /UMB:\s*No/i.test(desc);
  const glYes = /\bGL\b/.test(text) && !glNo;
  const wcYes = /\bWC\b/.test(text) && !wcNo;
  const umbYes = /\bUMB\b/.test(text) && !umbNo;
  if (glYes && wcYes && umbYes) return "gl_wc_umb";
  if (glYes && wcYes) return "gl_wc";
  if (glYes) return "gl";
  if (wcYes) return "wc";
  if (umbYes) return "umb";
  return null;
}

// ─── CSV Parser ──────────────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let i = 0;
  const len = text.length;

  function parseField() {
    if (i >= len || text[i] === "\n" || text[i] === "\r") return "";
    if (text[i] === '"') {
      i++;
      let field = "";
      while (i < len) {
        if (text[i] === '"') {
          if (i + 1 < len && text[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          field += text[i];
          i++;
        }
      }
      return field;
    } else {
      let field = "";
      while (i < len && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
        field += text[i];
        i++;
      }
      return field;
    }
  }

  while (i < len) {
    const row = [];
    while (true) {
      row.push(parseField());
      if (i >= len || text[i] === "\n" || text[i] === "\r") {
        if (text[i] === "\r" && i + 1 < len && text[i + 1] === "\n") i += 2;
        else if (text[i] === "\n" || text[i] === "\r") i++;
        break;
      }
      if (text[i] === ",") i++;
    }
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

// ─── SQL Escaping ────────────────────────────────────────────────────────────
function esc(str) {
  if (str === null || str === undefined) return "NULL";
  return "'" + str.replace(/'/g, "''") + "'";
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Parsing CSV...");
  const csvText = await readFile(CSV_PATH, "utf8");
  const rows = parseCSV(csvText);
  const headers = rows[0];
  const dataRows = rows.slice(1);

  const colIdx = {};
  headers.forEach((h, i) => { colIdx[h] = i; });

  console.log(`Columns: ${headers.length}, Data rows: ${dataRows.length}`);

  const sql = [];
  sql.push("-- Andrea Rueda Trello Import");
  sql.push("-- Generated: " + new Date().toISOString());
  sql.push("-- Run this in the Supabase SQL editor");
  sql.push("");
  sql.push("-- First, get Andrea's profile ID");
  sql.push("DO $$");
  sql.push("DECLARE");
  sql.push("  v_andrea_id uuid;");
  sql.push("  v_quote_id uuid;");
  sql.push("  v_checklist_id uuid;");
  sql.push("BEGIN");
  sql.push("  SELECT id INTO v_andrea_id FROM public.profiles WHERE username = 'andrear' LIMIT 1;");
  sql.push("  IF v_andrea_id IS NULL THEN");
  sql.push("    RAISE EXCEPTION 'Profile andrear not found';");
  sql.push("  END IF;");
  sql.push("");

  let cardCount = 0;

  for (const row of dataRows) {
    const name = (row[colIdx["name"]] || "").trim();
    const desc = row[colIdx["desc"]] || "";
    const closed = row[colIdx["closed"]] === "true";
    const isTemplate = row[colIdx["isTemplate"]] === "true";
    const idList = row[colIdx["idList"]] || "";
    const dateLastActivity = row[colIdx["dateLastActivity"]] || "";
    const checklistsRaw = row[colIdx["checklists"]] || "[]";

    if (closed || isTemplate || !name || name.includes("Quote Template")) continue;

    const boardColumn = LIST_MAP[idList];
    if (!boardColumn) continue;

    const coverageType = detectCoverage(name, desc);
    const createdAt = dateLastActivity || new Date().toISOString();

    // Parse checklists
    let checklists = [];
    try { checklists = JSON.parse(checklistsRaw); } catch {}

    cardCount++;
    sql.push(`  -- Card ${cardCount}: ${name.slice(0, 60)}`);
    sql.push(`  INSERT INTO public.commercial_quotes (business_name, description, board_column, column_position, risk_level, card_status, coverage_type, assigned_to, is_mirrored, is_deleted, created_at, board_entered_at, column_entered_at)`);
    sql.push(`  VALUES (${esc(name.slice(0, 250))}, ${esc(desc || null)}, ${esc(boardColumn)}, ${cardCount}, 'medium', 'in_progress', ${coverageType ? esc(coverageType) : "NULL"}, v_andrea_id, true, false, ${esc(createdAt)}, ${esc(createdAt)}, ${esc(createdAt)})`);
    sql.push(`  RETURNING id INTO v_quote_id;`);
    sql.push("");

    // Column history
    sql.push(`  INSERT INTO public.commercial_quote_column_history (quote_id, from_column, to_column, moved_by, moved_at)`);
    sql.push(`  VALUES (v_quote_id, NULL, ${esc(boardColumn)}, v_andrea_id, ${esc(createdAt)});`);
    sql.push("");

    // Checklists
    if (checklists.length > 0) {
      for (const cl of checklists) {
        const clTitle = cl.name || "Checklist";
        sql.push(`  INSERT INTO public.commercial_quote_checklists (quote_id, title, position)`);
        sql.push(`  VALUES (v_quote_id, ${esc(clTitle)}, 0)`);
        sql.push(`  RETURNING id INTO v_checklist_id;`);

        if (cl.checkItems && cl.checkItems.length > 0) {
          for (let idx = 0; idx < cl.checkItems.length; idx++) {
            const item = cl.checkItems[idx];
            const isChecked = item.state === "complete";
            sql.push(`  INSERT INTO public.commercial_quote_checklist_items (checklist_id, label, is_checked, position)`);
            sql.push(`  VALUES (v_checklist_id, ${esc(item.name)}, ${isChecked}, ${idx + 1});`);
          }
        }
        sql.push("");
      }
    } else {
      // Default checklist
      sql.push(`  INSERT INTO public.commercial_quote_checklists (quote_id, title, position)`);
      sql.push(`  VALUES (v_quote_id, 'Required Documents', 0)`);
      sql.push(`  RETURNING id INTO v_checklist_id;`);
      sql.push(`  INSERT INTO public.commercial_quote_checklist_items (checklist_id, label, is_checked, position) VALUES (v_checklist_id, 'Recording', false, 1);`);
      sql.push(`  INSERT INTO public.commercial_quote_checklist_items (checklist_id, label, is_checked, position) VALUES (v_checklist_id, 'Email', false, 2);`);
      sql.push(`  INSERT INTO public.commercial_quote_checklist_items (checklist_id, label, is_checked, position) VALUES (v_checklist_id, 'Form', false, 3);`);
      sql.push("");
    }

    sql.push("");
  }

  sql.push("  RAISE NOTICE 'Imported % cards for Andrea Rueda', " + cardCount + ";");
  sql.push("END $$;");

  await writeFile(OUTPUT_PATH, sql.join("\n"), "utf8");
  console.log(`\n✅ Generated ${OUTPUT_PATH}`);
  console.log(`   Cards: ${cardCount}`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
