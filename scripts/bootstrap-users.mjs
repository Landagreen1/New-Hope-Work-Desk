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
  } else if (resetPasswords) {
    const { error } = await supabase.auth.admin.updateUserById(authUser.id, { password: entry.password });
    if (error) throw error;
    console.log(`Reset temporary password: ${entry.username}`);
  } else {
    console.log(`Already exists: ${entry.username}`);
  }

  idsByUsername.set(entry.username, authUser.id);

  const isAgent = entry.role === "agent";
  const { data: existingProfile, error: profileReadError } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", authUser.id)
    .maybeSingle();
  if (profileReadError) throw profileReadError;

  const profilePayload = {
    id: authUser.id,
    username: entry.username,
    display_name: entry.displayName,
    initials: entry.initials,
    role: entry.role,
    rotation_position: entry.rotationPosition,
    is_active: true,
    ...(!existingProfile ? {
      whatsapp_position: entry.rotationPosition,
      ringcentral_position: entry.rotationPosition,
      workload_position: entry.rotationPosition,
      availability: "unavailable",
      whatsapp_active: isAgent,
      ringcentral_active: isAgent,
      workload_active: isAgent,
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

  const { error } = await supabase.from("rotation_state").upsert({
    kind: rotation.kind,
    current_profile_id: idsByUsername.get(rotation.username),
    updated_by: idsByUsername.get("oscar"),
  }, { onConflict: "kind" });
  if (error) throw error;
}

console.log("\nBootstrap complete.");
console.log("12 user accounts are ready. Newly created or password-reset accounts must change their password on next login.");
console.log("Temporary credentials are in private/PRIVATE-USER-CREDENTIALS.txt.");
