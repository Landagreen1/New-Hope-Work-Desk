/**
 * Export payroll CSV for the period 07/25/2026 – 08/07/2026
 * Usage: node scripts/export-payroll-csv.mjs
 * Output: payroll-07-25-to-08-07.csv in project root
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

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

async function runQuery(sql) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    console.error(`Failed (${response.status}):`, text);
    process.exit(1);
  }
  return JSON.parse(text);
}

console.log('Querying Supabase...');

// Main daily data
const mainSql = `
WITH daily_data AS (
  SELECT
    tce.profile_id,
    (tce.clock_in AT TIME ZONE 'America/Chicago')::date AS work_date,
    COALESCE(tce.total_hours, 0) AS hours_worked,
    tce.is_overtime,
    tce.id AS entry_id,
    (tce.clock_in AT TIME ZONE 'America/Chicago')::time AS clock_in_time,
    (tce.clock_out AT TIME ZONE 'America/Chicago')::time AS clock_out_time
  FROM time_clock_entries tce
  WHERE tce.clock_in >= '2026-07-25'
    AND tce.clock_in < '2026-08-08'
    AND tce.clock_out IS NOT NULL
),
schedule_hours AS (
  SELECT
    es.profile_id,
    es.schedule_date,
    EXTRACT(EPOCH FROM (es.shift_end - es.shift_start)) / 3600.0 AS scheduled_hours
  FROM employee_schedules es
  WHERE es.schedule_date >= '2026-07-25'
    AND es.schedule_date <= '2026-08-07'
    AND es.status != 'cancelled'
)
SELECT
  p.display_name AS employee,
  dd.work_date AS date,
  ROUND(SUM(dd.hours_worked)::numeric, 2) AS hours_worked,
  ROUND(COALESCE(MAX(sh.scheduled_hours), 0)::numeric, 2) AS hours_scheduled,
  ROUND(COALESCE(SUM(CASE WHEN dd.is_overtime THEN dd.hours_worked ELSE 0 END), 0)::numeric, 2) AS overtime_hours,
  COALESCE(eps.hourly_rate, 0) AS rate_per_hour,
  ROUND((
    COALESCE(SUM(CASE WHEN NOT dd.is_overtime THEN dd.hours_worked ELSE 0 END), 0) * COALESCE(eps.hourly_rate, 0)
    + COALESCE(SUM(CASE WHEN dd.is_overtime THEN dd.hours_worked ELSE 0 END), 0) * COALESCE(eps.hourly_rate, 0) * COALESCE(eps.overtime_multiplier, 1.5)
  )::numeric, 2) AS total_pay,
  MIN(dd.clock_in_time)::text AS clock_in,
  MAX(dd.clock_out_time)::text AS clock_out
FROM daily_data dd
JOIN profiles p ON p.id = dd.profile_id
LEFT JOIN employee_payment_settings eps ON eps.profile_id = dd.profile_id
LEFT JOIN schedule_hours sh ON sh.profile_id = dd.profile_id AND sh.schedule_date = dd.work_date
GROUP BY p.display_name, dd.work_date, eps.hourly_rate, eps.overtime_multiplier
ORDER BY p.display_name, dd.work_date;
`;

// Breaks detail per entry per day
const breaksSql = `
SELECT
  p.display_name AS employee,
  (tce.clock_in AT TIME ZONE 'America/Chicago')::date AS work_date,
  tcb.break_type,
  (tcb.break_start AT TIME ZONE 'America/Chicago')::time::text AS break_start,
  (tcb.break_end AT TIME ZONE 'America/Chicago')::time::text AS break_end,
  COALESCE(tcb.duration_minutes, 0) AS duration_minutes
FROM time_clock_breaks tcb
JOIN time_clock_entries tce ON tce.id = tcb.clock_entry_id
JOIN profiles p ON p.id = tce.profile_id
WHERE tce.clock_in >= '2026-07-25' AND tce.clock_in < '2026-08-08'
  AND tce.clock_out IS NOT NULL
ORDER BY p.display_name, (tce.clock_in AT TIME ZONE 'America/Chicago')::date, tcb.break_start;
`;

const [rows, breaks] = await Promise.all([runQuery(mainSql), runQuery(breaksSql)]);

if (!rows.length) {
  console.error('No data returned.');
  process.exit(1);
}

// Index breaks by employee+date
const breaksMap = {}; // key: "employee|date" -> { short: [...], lunch: [...] }
for (const b of breaks) {
  const key = `${b.employee}|${b.work_date}`;
  if (!breaksMap[key]) breaksMap[key] = { short: [], lunch: [] };
  breaksMap[key][b.break_type].push(b);
}

// Compute period totals per employee
const periodTotals = {};
for (const r of rows) {
  if (!periodTotals[r.employee]) {
    periodTotals[r.employee] = { hours: 0, breakMin: 0, lunchMin: 0 };
  }
  periodTotals[r.employee].hours += parseFloat(r.hours_worked);
}
for (const b of breaks) {
  if (!periodTotals[b.employee]) {
    periodTotals[b.employee] = { hours: 0, breakMin: 0, lunchMin: 0 };
  }
  if (b.break_type === 'short') {
    periodTotals[b.employee].breakMin += b.duration_minutes;
  } else {
    periodTotals[b.employee].lunchMin += b.duration_minutes;
  }
}

// Build CSV
const headers = [
  'Employee',
  'Date',
  'Hours Worked',
  'Hours Scheduled',
  'Overtime Hours',
  'Rate Per Hour',
  'Total Pay',
  'Clock In',
  'Minutes Worked Before Break',
  'Break Start',
  'Break End',
  'Break Duration (min)',
  'Lunch Start',
  'Lunch End',
  'Lunch Duration (min)',
  'Clock Out',
  'Total Break Minutes (Day)',
  'Total Lunch Minutes (Day)',
  'Total Hours in Period',
  'Total Break Minutes in Period',
  'Total Lunch Minutes in Period',
];

function formatTime(t) {
  if (!t) return '';
  // t is like "07:48:00.297047" — trim to HH:MM
  const parts = t.split(':');
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}`;
  return t;
}

function minutesBetween(startStr, endStr) {
  if (!startStr || !endStr) return '';
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff < 0) diff += 24 * 60; // overnight
  return diff;
}

const csvLines = [headers.join(',')];

for (const r of rows) {
  const key = `${r.employee}|${r.date}`;
  const dayBreaks = breaksMap[key] || { short: [], lunch: [] };

  // First short break of the day
  const firstBreak = dayBreaks.short[0] || null;
  // First lunch of the day
  const firstLunch = dayBreaks.lunch[0] || null;

  const clockInFmt = formatTime(r.clock_in);
  const clockOutFmt = formatTime(r.clock_out);

  const breakStartFmt = firstBreak ? formatTime(firstBreak.break_start) : '';
  const breakEndFmt = firstBreak ? formatTime(firstBreak.break_end) : '';
  const breakDur = dayBreaks.short.reduce((s, b) => s + b.duration_minutes, 0);

  const lunchStartFmt = firstLunch ? formatTime(firstLunch.break_start) : '';
  const lunchEndFmt = firstLunch ? formatTime(firstLunch.break_end) : '';
  const lunchDur = dayBreaks.lunch.reduce((s, b) => s + b.duration_minutes, 0);

  // Minutes worked before first break (from clock in to first break/lunch, whichever came first)
  let firstEvent = null;
  if (firstBreak) firstEvent = firstBreak.break_start;
  if (firstLunch && (!firstEvent || firstLunch.break_start < firstEvent)) {
    firstEvent = firstLunch.break_start;
  }
  const minsBeforeBreak = firstEvent ? minutesBetween(clockInFmt, formatTime(firstEvent)) : '';

  const pt = periodTotals[r.employee] || { hours: 0, breakMin: 0, lunchMin: 0 };

  csvLines.push([
    `"${r.employee}"`,
    r.date,
    r.hours_worked,
    r.hours_scheduled,
    r.overtime_hours,
    r.rate_per_hour,
    r.total_pay,
    clockInFmt,
    minsBeforeBreak,
    breakStartFmt,
    breakEndFmt,
    breakDur || '',
    lunchStartFmt,
    lunchEndFmt,
    lunchDur || '',
    clockOutFmt,
    breakDur || 0,
    lunchDur || 0,
    pt.hours.toFixed(2),
    pt.breakMin,
    pt.lunchMin,
  ].join(','));
}

const outPath = resolve(import.meta.dirname, '..', 'payroll-07-25-to-08-07.csv');
writeFileSync(outPath, csvLines.join('\n'), 'utf-8');
console.log(`Done! CSV written to: ${outPath}`);
console.log(`Total rows: ${rows.length}`);
