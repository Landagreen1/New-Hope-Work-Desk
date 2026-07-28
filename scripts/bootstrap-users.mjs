import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const authDomain = process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "workdesk.newhope.local";
const resetPasswords = process.argv.includes("--reset-passwords");
const resetRotations = process.argv.includes("--reset-rotations");

if (!url || !secret) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(1);
}

const supabase = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const credentialsPath = new URL("../private/bootstrap-users.json", import.meta.url);
let users;
try {
  const payload = JSON.parse(await readFile(credentialsPath, "utf8"));
  users = payload.users;
} catch (error) {
  console.error("Missing or invalid private/bootstrap-users.json. Use the private file included with the release package.");
  throw error;
}


const dealerNames = [
  "AutoMax of Gastonia",
  "Carolina Auto Exchange",
  "Catawba Motors",
  "Charlotte Truck Center",
  "Freedom Auto Sales",
  "Gaston Auto Group",
  "Queen City Motors",
  "Roadway Auto Plaza",
  "Southside Motors",
  "Victory Auto Sales",
];

async function listAllUsers() {
  const output = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    output.push(...data.users);
    if (data.users.length < 1000) return output;
  }
}

const existing = await listAllUsers();
const idsByUsername = new Map();

for (const entry of users) {
  const email = `${entry.username}@${authDomain}`;
  let authUser = existing.find((user) => user.email?.toLowerCase() === email.toLowerCase());
  let createdNow = false;

  if (!authUser) {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: entry.password,
      email_confirm: true,
      user_metadata: {
        username: entry.username,
        display_name: entry.displayName,
        role: entry.role,
      },
    });
    if (error) throw error;
    authUser = data.user;
    createdNow = true;
    console.log(`Created ${entry.role}: ${entry.username}`);
  } else {
    const authUpdates = {
      user_metadata: {
        ...authUser.user_metadata,
        username: entry.username,
        display_name: entry.displayName,
        role: entry.role,
      },
      ...(resetPasswords ? { password: entry.password } : {}),
    };
    const { error } = await supabase.auth.admin.updateUserById(authUser.id, authUpdates);
    if (error) throw error;
    console.log(resetPasswords
      ? `Updated role and reset temporary password: ${entry.username}`
      : `Updated role/profile metadata: ${entry.username}`);
  }

  idsByUsername.set(entry.username, authUser.id);

  const isAgent = entry.role === "agent";
  const { data: existingProfile, error: profileReadError } = await supabase
    .from("profiles")
    .select("id,rotation_position,whatsapp_position,ringcentral_position,workload_position")
    .eq("id", authUser.id)
    .maybeSingle();
  if (profileReadError) throw profileReadError;

  const rotationPosition = Number(entry.rotationPosition ?? existingProfile?.rotation_position ?? 0);
  const profilePayload = {
    id: authUser.id,
    username: entry.username,
    display_name: entry.displayName,
    initials: entry.initials,
    role: entry.role,
    rotation_position: rotationPosition,
    is_active: true,
    ...(!existingProfile ? {
      whatsapp_position: rotationPosition,
      ringcentral_position: rotationPosition,
      workload_position: rotationPosition,
      availability: "unavailable",
    } : {}),
    // Supervisors and all other non-agent roles must never retain queue
    // eligibility when an existing Sales Agent is promoted.
    ...(!isAgent ? {
      whatsapp_active: false,
      ringcentral_active: false,
      workload_active: false,
    } : !existingProfile ? {
      whatsapp_active: true,
      ringcentral_active: true,
      workload_active: true,
    } : {}),
    ...(createdNow || resetPasswords ? { must_change_password: true } : {}),
  };
  const { error: profileError } = await supabase.from("profiles").upsert(profilePayload, { onConflict: "id" });
  if (profileError) throw profileError;
}

for (const name of dealerNames) {
  const { error } = await supabase.from("dealers").upsert({ name, is_active: true }, { onConflict: "name" });
  if (error) throw error;
}

const initialRotations = [
  { kind: "whatsapp", username: "berenice" },
  { kind: "ringcentral", username: "galo" },
  { kind: "workload", username: "pablo" },
];

for (const rotation of initialRotations) {
  const { data: existingRotation, error: rotationReadError } = await supabase
    .from("rotation_state")
    .select("kind")
    .eq("kind", rotation.kind)
    .maybeSingle();
  if (rotationReadError) throw rotationReadError;

  if (existingRotation && !resetRotations) {
    console.log(`Preserved current ${rotation.kind} rotation.`);
    continue;
  }

  const currentProfileId = idsByUsername.get(rotation.username);
  const updatedBy = idsByUsername.get("oscar");
  if (!currentProfileId || !updatedBy) {
    console.warn(`Skipped missing ${rotation.kind} seed rotation; referenced bootstrap users are not in this provisioning batch.`);
    continue;
  }

  const { error } = await supabase.from("rotation_state").upsert({
    kind: rotation.kind,
    current_profile_id: currentProfileId,
    updated_by: updatedBy,
  }, { onConflict: "kind" });
  if (error) throw error;
}

console.log("\nBootstrap complete.");
console.log(`${users.length} requested user accounts were created or updated. Newly created or password-reset accounts must change their password on next login.`);
console.log("Temporary credentials remain in private/bootstrap-users.json.");
