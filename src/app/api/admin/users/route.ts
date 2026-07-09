import { randomBytes } from "node:crypto";

import { createClient as createSupabaseAdmin } from "@supabase/supabase-js";

import { createClient as createSessionClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;

type AppRole = "agent" | "manager";

function generateTemporaryPassword() {
  return `NH!${randomBytes(9).toString("base64url")}26`;
}

async function getAuthorizedClients() {
  const sessionClient = await createSessionClient();
  if (!sessionClient) {
    return { error: Response.json({ error: "Supabase is not configured." }, { status: 503 }) };
  }

  const { data: claimsData } = await sessionClient.auth.getClaims();
  const userId = claimsData?.claims?.sub;
  if (!userId) {
    return { error: Response.json({ error: "Authentication required." }, { status: 401 }) };
  }

  const { data: profile } = await sessionClient
    .from("profiles")
    .select("id,role,is_active")
    .eq("id", userId)
    .single();

  if (!profile?.is_active || profile.role !== "manager") {
    return { error: Response.json({ error: "Manager permission required." }, { status: 403 }) };
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secret) {
    return {
      error: Response.json(
        { error: "User administration is not configured. Add SUPABASE_SECRET_KEY to the server environment." },
        { status: 503 },
      ),
    };
  }

  const admin = createSupabaseAdmin(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  return { admin, managerId: userId };
}

export async function GET() {
  const authorization = await getAuthorizedClients();
  if ("error" in authorization) return authorization.error;

  const { data, error } = await authorization.admin
    .from("profiles")
    .select("id,username,display_name,initials,role,rotation_position,availability,is_active,must_change_password,created_at")
    .order("rotation_position");

  if (error) return Response.json({ error: error.message }, { status: 400 });

  return Response.json({ users: data ?? [] });
}

export async function POST(request: Request) {
  const authorization = await getAuthorizedClients();
  if ("error" in authorization) return authorization.error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const username = String(body.username ?? "").trim().toLowerCase().replace(/\s+/g, "");
  const displayName = String(body.displayName ?? "").trim();
  const requestedInitials = String(body.initials ?? "").trim().toUpperCase();
  const role = String(body.role ?? "agent") as AppRole;

  if (!USERNAME_PATTERN.test(username)) {
    return Response.json({ error: "Username must be 3–30 characters using letters, numbers, periods, underscores, or hyphens." }, { status: 400 });
  }
  if (displayName.length < 2 || displayName.length > 80) {
    return Response.json({ error: "Display name must be between 2 and 80 characters." }, { status: 400 });
  }
  if (role !== "agent" && role !== "manager") {
    return Response.json({ error: "Role must be agent or manager." }, { status: 400 });
  }

  const initials = (requestedInitials || displayName.split(/\s+/).map((part) => part[0]).join("").slice(0, 3)).slice(0, 4);
  if (!initials) return Response.json({ error: "Initials are required." }, { status: 400 });

  const { data: existingProfile } = await authorization.admin
    .from("profiles")
    .select("id")
    .eq("username", username)
    .maybeSingle();
  if (existingProfile) return Response.json({ error: "That username already exists." }, { status: 409 });

  const authDomain = process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "workdesk.newhope.local";
  const password = generateTemporaryPassword();
  const email = `${username}@${authDomain}`;

  const { data: created, error: createError } = await authorization.admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, display_name: displayName, role },
  });

  if (createError || !created.user) {
    return Response.json({ error: createError?.message || "Unable to create user." }, { status: 400 });
  }

  const { data: lastPosition, error: positionError } = await authorization.admin
    .from("profiles")
    .select("rotation_position")
    .order("rotation_position", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (positionError) {
    await authorization.admin.auth.admin.deleteUser(created.user.id);
    return Response.json({ error: positionError.message }, { status: 400 });
  }

  const rotationPosition = Number(lastPosition?.rotation_position ?? 0) + 1;
  const isAgent = role === "agent";

  const { data: queuePositions, error: queuePositionError } = await authorization.admin
    .from("profiles")
    .select("whatsapp_position,ringcentral_position,workload_position")
    .eq("role", "agent")
    .eq("is_active", true);

  if (queuePositionError) {
    await authorization.admin.auth.admin.deleteUser(created.user.id);
    return Response.json({ error: queuePositionError.message }, { status: 400 });
  }

  const nextWhatsappPosition = Math.max(0, ...(queuePositions ?? []).map((row) => Number(row.whatsapp_position ?? 0))) + 1;
  const nextRingCentralPosition = Math.max(0, ...(queuePositions ?? []).map((row) => Number(row.ringcentral_position ?? 0))) + 1;
  const nextWorkloadPosition = Math.max(0, ...(queuePositions ?? []).map((row) => Number(row.workload_position ?? 0))) + 1;

  const { error: profileError } = await authorization.admin.from("profiles").insert({
    id: created.user.id,
    username,
    display_name: displayName,
    initials,
    role,
    rotation_position: rotationPosition,
    whatsapp_position: isAgent ? nextWhatsappPosition : rotationPosition,
    ringcentral_position: isAgent ? nextRingCentralPosition : rotationPosition,
    workload_position: isAgent ? nextWorkloadPosition : rotationPosition,
    availability: "unavailable",
    whatsapp_active: isAgent,
    ringcentral_active: isAgent,
    workload_active: isAgent,
    is_active: true,
    must_change_password: true,
  });

  if (profileError) {
    await authorization.admin.auth.admin.deleteUser(created.user.id);
    return Response.json({ error: profileError.message }, { status: 400 });
  }

  await authorization.admin.from("audit_log").insert({
    actor_profile_id: authorization.managerId,
    action: "user_created",
    entity_type: "profile",
    entity_id: created.user.id,
    new_value: { username, display_name: displayName, initials, role, rotation_position: rotationPosition, whatsapp_position: nextWhatsappPosition, ringcentral_position: nextRingCentralPosition, workload_position: nextWorkloadPosition },
    reason: "Created from User Administration",
  });

  return Response.json({
    user: { id: created.user.id, username, display_name: displayName, initials, role, rotation_position: rotationPosition, availability: "unavailable", is_active: true, must_change_password: true },
    temporaryPassword: password,
  });
}

export async function PATCH(request: Request) {
  const authorization = await getAuthorizedClients();
  if ("error" in authorization) return authorization.error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const userId = String(body.userId ?? "").trim();
  const password = String(body.temporaryPassword ?? "");
  if (!userId) return Response.json({ error: "User ID is required." }, { status: 400 });
  if (password.length < 8 || password.length > 72) {
    return Response.json({ error: "Temporary password must be between 8 and 72 characters." }, { status: 400 });
  }
  if (password.trim() !== password) {
    return Response.json({ error: "Temporary password cannot start or end with spaces." }, { status: 400 });
  }

  const { data: profile, error: profileError } = await authorization.admin
    .from("profiles")
    .select("id,username,display_name,is_active")
    .eq("id", userId)
    .single();

  if (profileError || !profile?.is_active) {
    return Response.json({ error: "Active user not found." }, { status: 404 });
  }

  const { error: authError } = await authorization.admin.auth.admin.updateUserById(userId, { password });
  if (authError) return Response.json({ error: authError.message }, { status: 400 });

  const { error: updateError } = await authorization.admin
    .from("profiles")
    .update({ must_change_password: true })
    .eq("id", userId);
  if (updateError) return Response.json({ error: updateError.message }, { status: 400 });

  await authorization.admin.from("audit_log").insert({
    actor_profile_id: authorization.managerId,
    action: "password_reset",
    entity_type: "profile",
    entity_id: userId,
    reason: "Manager-set temporary password reset from User Administration",
  });

  return Response.json({ username: profile.username, displayName: profile.display_name, temporaryPassword: password });
}
