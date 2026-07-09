"use client";

import { CheckCircle2, KeyRound, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { createClient } from "@/lib/supabase/client";

export function ChangePasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password.length < 10) return setError("Use at least 10 characters.");
    if (password !== confirm) return setError("The passwords do not match.");
    setLoading(true);

    try {
      const supabase = createClient();
      const { error: passwordError } = await supabase.auth.updateUser({ password });
      if (passwordError) throw passwordError;
      const { error: profileError } = await supabase.rpc("complete_password_change");
      if (profileError) throw profileError;
      router.replace("/");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to change password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-[#eef2f7] p-4">
      <div className="w-full max-w-lg rounded-[32px] border border-slate-200 bg-white p-7 shadow-xl sm:p-9">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]"><ShieldCheck className="h-7 w-7" /></div>
        <p className="mt-7 text-xs font-black uppercase tracking-[0.18em] text-[#4d6aa8]">First login security</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Create your private password</h1>
        <p className="mt-3 text-sm font-semibold leading-6 text-slate-500">The password management gave you is temporary. Replace it before using the Work Desk.</p>
        <form onSubmit={handleSubmit} className="mt-7 space-y-5">
          <label className="block"><span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-slate-500">New password</span><div className="flex items-center rounded-2xl border border-slate-200 px-4 focus-within:border-[#6b84b5] focus-within:ring-4 focus-within:ring-[#eef3fb]"><KeyRound className="h-5 w-5 text-slate-400" /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" className="flex-1 bg-transparent px-3 py-3.5 font-bold outline-none" required /></div></label>
          <label className="block"><span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-slate-500">Confirm password</span><input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" className="w-full rounded-2xl border border-slate-200 px-4 py-3.5 font-bold outline-none focus:border-[#6b84b5] focus:ring-4 focus:ring-[#eef3fb]" required /></label>
          <div className="rounded-2xl bg-slate-50 p-4 text-sm font-semibold text-slate-600"><div className="flex gap-2"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#4d6aa8]" />Use at least 10 characters and do not share this password with another agent.</div></div>
          {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{error}</div> : null}
          <button disabled={loading} className="w-full rounded-2xl bg-[#223f7a] px-4 py-3.5 font-black text-white disabled:opacity-60">{loading ? "Saving..." : "Save Password & Continue"}</button>
        </form>
      </div>
    </div>
  );
}
