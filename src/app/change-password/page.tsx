export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";

import { ChangePasswordForm } from "@/components/change-password-form";
import { createClient } from "@/lib/supabase/server";

export default async function ChangePasswordPage() {
  const supabase = await createClient();
  if (!supabase) redirect("/setup");
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) redirect("/login");
  const { data: profile } = await supabase.from("profiles").select("must_change_password").eq("id", userId).single();
  if (profile && !profile.must_change_password) redirect("/");
  return <ChangePasswordForm />;
}
