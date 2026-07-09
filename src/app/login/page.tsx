export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { createClient } from "@/lib/supabase/server";

export default async function LoginPage() {
  const supabase = await createClient();
  if (!supabase) redirect("/setup");
  const { data } = await supabase.auth.getClaims();
  if (data?.claims?.sub) redirect("/");
  return <LoginForm />;
}
