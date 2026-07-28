/**
 * Assign recurring weekly schedules for all employees.
 * Run with: node scripts/assign-schedules.mjs
 *
 * This script:
 * 1. Looks up all profiles by display_name
 * 2. Assigns Mon-Fri schedules (regular or after-hours)
 * 3. Assigns Saturday rotation for August 2026
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ─── Schedule Definitions ─────────────────────────────────────────────────────

// Regular schedule: 08:50 - 17:50 Mon-Fri
const REGULAR_SCHEDULE = { start: "08:50", end: "17:50", days: [1, 2, 3, 4, 5] }; // Mon=1 ... Fri=5

// After-hours schedule: 11:50 - 20:30 Tue-Fri (some have Mon too)
const AFTER_HOURS_SCHEDULE = { start: "11:50", end: "20:30", days: [2, 3, 4, 5] }; // Tue-Fri

// Saturday regular: 08:50 - 17:50
const SATURDAY_REGULAR = { start: "08:50", end: "17:50" };
// Saturday after-hours: 11:50 - 20:30
const SATURDAY_AFTER = { start: "11:50", end: "20:30" };

// ─── Employee Assignments ─────────────────────────────────────────────────────

// Regular Mon-Fri (08:50 - 17:50)
const REGULAR_EMPLOYEES = [
  "Alfaro Galo",
  "Bollate Berenice",
  "Rivadenaira Alvaro",
  "Maria Emilia Trujillo",
  "Maria Emilia Zumarraga",
  "Barros Alejandro",
  "Chinlle Ricardo",
  "Cruz Erick",
  "Hernandez Angelica",
  "Micaela Delgado",
  "Mac Gregor Osmary",
  "Morales Andres",
  "Morales Brenda",
  "Ortiz Zaira",
  "Rosales Jose",
  "Talavera Vivian",
  "Vargas Milton",
  "John Parra",
  "Thalita Revelo",
  "Andrea Rodriguez",
  "Daniel Perez",
  "Cabezas Santiago",
  "Cardenas Jossue",
  "Gonzalez Giovanny",
  "Moreno Axel",
  "Rueda Andrea",
  "Salazar Gabriel",
  "Vasquez Diana",
  "Garcia Daniela",
];

// After-hours Tue-Fri (11:50 - 20:30)
const AFTER_HOURS_EMPLOYEES = [
  "Bayas Estefania",
  "Gutierrez Elvin",
  "Leiva Miguel",
  "Plaza Mauricio",
  "Teran Pablo",
];

// Special schedules
const SPECIAL_SCHEDULES = [
  // Hernandez Juliana: Mon & Thu only (08:50 - 17:50)
  { name: "Hernandez Juliana", start: "08:50", end: "17:50", days: [1, 4] },
  // Rueda Felipe: Tue only (08:50 - 17:50) per the schedule image showing only Tuesday
  { name: "Rueda Felipe", start: "08:50", end: "17:50", days: [2] },
];

// Toro Jason: No weekday schedule (only Saturday rotation)

// ─── Saturday Rotation (August 2026) ─────────────────────────────────────────

// Saturday dates in August 2026
const SATURDAY_DATES = ["2026-08-01", "2026-08-08", "2026-08-15", "2026-08-22", "2026-08-29"];

// "(after)" = after-hours shift on Saturday
const SATURDAY_ROTATION = {
  "2026-08-01": [
    { name: "Alfaro Galo", after: false },
    { name: "Bollate Berenice", after: false },
    { name: "Bayas Estefania", after: true },
    { name: "Leiva Miguel", after: true },
    { name: "Plaza Mauricio", after: true },
    { name: "Teran Pablo", after: true },
    { name: "Maria Emilia Zumarraga", after: false },
    { name: "Barros Alejandro", after: false },
    { name: "Morales Andres", after: false },
    { name: "Ortiz Zaira", after: false },
    { name: "Rosales Jose", after: false },
    { name: "Talavera Vivian", after: false },
    { name: "Thalita Revelo", after: false },
    { name: "Cardenas Jossue", after: false },
    { name: "Moreno Axel", after: false },
  ],
  "2026-08-08": [
    { name: "Alfaro Galo", after: false },
    { name: "Bollate Berenice", after: false },
    { name: "Bayas Estefania", after: true },
    { name: "Gutierrez Elvin", after: true },
    { name: "Leiva Miguel", after: true },
    { name: "Plaza Mauricio", after: true },
    { name: "Teran Pablo", after: true },
    { name: "Toro Jason", after: false },
    { name: "Hernandez Angelica", after: false },
    { name: "Mac Gregor Osmary", after: false },
    { name: "Rueda Felipe", after: false },
    { name: "Talavera Vivian", after: false },
    { name: "Vargas Milton", after: false },
    { name: "Daniel Perez", after: false },
    { name: "Vasquez Diana", after: false },
  ],
  "2026-08-15": [
    { name: "Alfaro Galo", after: false },
    { name: "Bayas Estefania", after: true },
    { name: "Hernandez Juliana", after: false },
    { name: "Leiva Miguel", after: true },
    { name: "Plaza Mauricio", after: true },
    { name: "Teran Pablo", after: true },
    { name: "Rivadenaira Alvaro", after: false },
    { name: "Barros Alejandro", after: false },
    { name: "Chinlle Ricardo", after: false },
    { name: "Micaela Delgado", after: false },
    { name: "Morales Andres", after: false },
    { name: "Morales Brenda", after: false },
    { name: "Ortiz Zaira", after: false },
    { name: "John Parra", after: false },
    { name: "Thalita Revelo", after: false },
    { name: "Daniel Perez", after: false },
    { name: "Gonzalez Giovanny", after: false },
    { name: "Garcia Daniela", after: false },
  ],
  "2026-08-22": [
    { name: "Alfaro Galo", after: false },
    { name: "Bayas Estefania", after: true },
    { name: "Hernandez Juliana", after: false },
    { name: "Gutierrez Elvin", after: true },
    { name: "Leiva Miguel", after: true },
    { name: "Plaza Mauricio", after: true },
    { name: "Teran Pablo", after: true },
    { name: "Cruz Erick", after: false },
    { name: "Hernandez Angelica", after: false },
    { name: "Morales Brenda", after: false },
    { name: "Rosales Jose", after: false },
    { name: "Talavera Vivian", after: false },
    { name: "Daniel Perez", after: false },
    { name: "Moreno Axel", after: false },
    { name: "Salazar Gabriel", after: false },
  ],
  "2026-08-29": [
    { name: "Bayas Estefania", after: true },
    { name: "Gutierrez Elvin", after: true },
    { name: "Leiva Miguel", after: true },
    { name: "Plaza Mauricio", after: true },
    { name: "Teran Pablo", after: true },
    { name: "Toro Jason", after: false },
    { name: "Maria Emilia Zumarraga", after: false },
    { name: "Barros Alejandro", after: false },
    { name: "Chinlle Ricardo", after: false },
    { name: "Hernandez Angelica", after: false },
    { name: "Mac Gregor Osmary", after: false },
    { name: "Morales Andres", after: false },
    { name: "Thalita Revelo", after: false },
    { name: "Daniel Perez", after: false },
    { name: "Cabezas Santiago", after: false },
    { name: "Cardenas Jossue", after: false },
    { name: "Garcia Daniela", after: false },
  ],
};

// ─── Helper: Generate dates for a range ───────────────────────────────────────

function getWeekdayDates(startDate, endDate, daysOfWeek) {
  const dates = [];
  const current = new Date(startDate + "T00:00:00");
  const end = new Date(endDate + "T00:00:00");

  while (current <= end) {
    const dow = current.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
    if (daysOfWeek.includes(dow)) {
      dates.push(current.toISOString().split("T")[0]);
    }
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🔍 Fetching all profiles...");

  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id, display_name, is_active")
    .eq("is_active", true);

  if (error) {
    console.error("Failed to fetch profiles:", error.message);
    process.exit(1);
  }

  console.log(`  Found ${profiles.length} active profiles`);

  // Create a map of display_name (lowercase) -> profile_id
  const nameToId = new Map();
  for (const p of profiles) {
    nameToId.set(p.display_name.toLowerCase(), p.id);
  }

  function resolveId(name) {
    const id = nameToId.get(name.toLowerCase());
    if (!id) {
      // Try partial match
      for (const [key, value] of nameToId.entries()) {
        if (key.includes(name.toLowerCase()) || name.toLowerCase().includes(key)) {
          return value;
        }
      }
      console.warn(`  ⚠️  Could not resolve: "${name}"`);
      return null;
    }
    return id;
  }

  // We'll generate schedules for the 5 weeks of August 2026 (Aug 1 - Aug 31)
  const SCHEDULE_START = "2026-08-01";
  const SCHEDULE_END = "2026-08-31";

  const scheduleRows = [];

  // Get a super admin profile_id for created_by
  const { data: adminProfile } = await supabase
    .from("profiles")
    .select("id")
    .eq("role", "super_admin")
    .limit(1)
    .single();

  const createdBy = adminProfile?.id || profiles[0]?.id;

  console.log("\n📅 Generating regular schedules (08:50-17:50, Mon-Fri)...");
  for (const name of REGULAR_EMPLOYEES) {
    const id = resolveId(name);
    if (!id) continue;
    const dates = getWeekdayDates(SCHEDULE_START, SCHEDULE_END, REGULAR_SCHEDULE.days);
    for (const date of dates) {
      scheduleRows.push({
        profile_id: id,
        schedule_date: date,
        shift_start: REGULAR_SCHEDULE.start,
        shift_end: REGULAR_SCHEDULE.end,
        shift_type: "regular",
        status: "published",
        created_by: createdBy,
      });
    }
  }
  console.log(`  ${REGULAR_EMPLOYEES.length} employees × Mon-Fri`);

  console.log("\n🌙 Generating after-hours schedules (11:50-20:30, Tue-Fri)...");
  for (const name of AFTER_HOURS_EMPLOYEES) {
    const id = resolveId(name);
    if (!id) continue;
    const dates = getWeekdayDates(SCHEDULE_START, SCHEDULE_END, AFTER_HOURS_SCHEDULE.days);
    for (const date of dates) {
      scheduleRows.push({
        profile_id: id,
        schedule_date: date,
        shift_start: AFTER_HOURS_SCHEDULE.start,
        shift_end: AFTER_HOURS_SCHEDULE.end,
        shift_type: "regular",
        status: "published",
        created_by: createdBy,
      });
    }
  }
  console.log(`  ${AFTER_HOURS_EMPLOYEES.length} employees × Tue-Fri`);

  console.log("\n⚙️  Generating special schedules...");
  for (const spec of SPECIAL_SCHEDULES) {
    const id = resolveId(spec.name);
    if (!id) continue;
    const dates = getWeekdayDates(SCHEDULE_START, SCHEDULE_END, spec.days);
    for (const date of dates) {
      scheduleRows.push({
        profile_id: id,
        schedule_date: date,
        shift_start: spec.start,
        shift_end: spec.end,
        shift_type: "regular",
        status: "published",
        created_by: createdBy,
      });
    }
    console.log(`  ${spec.name}: ${spec.days.map(d => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d]).join(", ")}`);
  }

  console.log("\n🗓️  Generating Saturday rotation...");
  for (const [date, assignments] of Object.entries(SATURDAY_ROTATION)) {
    for (const { name, after } of assignments) {
      const id = resolveId(name);
      if (!id) continue;
      const shift = after ? SATURDAY_AFTER : SATURDAY_REGULAR;
      scheduleRows.push({
        profile_id: id,
        schedule_date: date,
        shift_start: shift.start,
        shift_end: shift.end,
        shift_type: after ? "overtime" : "regular",
        status: "published",
        notes: after ? "Saturday after-hours" : "Saturday rotation",
        created_by: createdBy,
      });
    }
  }
  console.log(`  ${SATURDAY_DATES.length} Saturdays configured`);

  console.log(`\n📝 Total schedule entries to insert: ${scheduleRows.length}`);

  // First delete existing schedules in Aug 2026 to avoid conflicts
  console.log("\n🗑️  Clearing existing schedules for Aug 2026...");
  const { error: delError } = await supabase
    .from("employee_schedules")
    .delete()
    .gte("schedule_date", SCHEDULE_START)
    .lte("schedule_date", SCHEDULE_END);

  if (delError) {
    console.error("Delete error:", delError.message);
    process.exit(1);
  }

  // Insert in batches of 100
  console.log("💾 Inserting schedules...");
  const BATCH_SIZE = 100;
  let inserted = 0;
  for (let i = 0; i < scheduleRows.length; i += BATCH_SIZE) {
    const batch = scheduleRows.slice(i, i + BATCH_SIZE);
    const { error: insError } = await supabase
      .from("employee_schedules")
      .insert(batch);

    if (insError) {
      console.error(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} error:`, insError.message);
      // Try individual inserts for this batch to handle conflicts
      for (const row of batch) {
        const { error: singleErr } = await supabase
          .from("employee_schedules")
          .upsert(row, { onConflict: "profile_id,schedule_date" });
        if (!singleErr) inserted++;
      }
    } else {
      inserted += batch.length;
    }
    process.stdout.write(`  Progress: ${inserted}/${scheduleRows.length}\r`);
  }

  console.log(`\n\n✅ Done! Inserted ${inserted} schedule entries.`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
