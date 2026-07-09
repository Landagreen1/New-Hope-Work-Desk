"use client";

import { Eye, EyeOff, LockKeyhole, LogIn, UserRound } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { createClient } from "@/lib/supabase/client";

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const supabase = createClient();
      const domain = process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "workdesk.newhope.local";
      const normalized = username.trim().toLowerCase().replace(/\s+/g, "");
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: `${normalized}@${domain}`,
        password,
      });

      if (signInError) throw signInError;
      router.replace("/");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to sign in.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#eef2f7] px-4 py-10 text-slate-950">
      <div className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-6xl overflow-hidden rounded-[36px] border border-[#d9e1ed] bg-white shadow-2xl shadow-slate-300/60 lg:grid-cols-[1.02fr_.98fr]">
        <section className="relative hidden overflow-hidden bg-[#f3f6fb] p-12 lg:flex lg:flex-col lg:justify-between">
          <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-[#223f7a]/10 blur-3xl" />
          <div className="absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-[#6b84b5]/15 blur-3xl" />
          <div className="relative">
            <Image src="/new-hope-logo-vertical.png" alt="New Hope Insurance" width={360} height={270} className="h-auto w-72 object-contain" priority />
            <p className="mt-8 text-xs font-black uppercase tracking-[0.25em] text-[#4d6aa8]">Internal Operations</p>
            <h1 className="mt-3 max-w-lg text-5xl font-black tracking-tight text-[#17305f]">One desk for turns, workload, follow-up, and reports.</h1>
            <p className="mt-5 max-w-xl text-base font-semibold leading-7 text-slate-600">Each employee signs in to their own workspace. Agent actions stay tied to the logged-in user, while management receives a separate operational view.</p>
          </div>
          <div className="relative grid gap-3 sm:grid-cols-3">
            {[
              ["3", "Independent rotations"],
              ["Live", "Manager visibility"],
              ["Secure", "Role-based access"],
            ].map(([value, label]) => <div key={label} className="rounded-2xl border border-[#d4deed] bg-white/80 p-4 backdrop-blur"><p className="text-2xl font-black text-[#223f7a]">{value}</p><p className="mt-1 text-xs font-bold text-slate-500">{label}</p></div>)}
          </div>
        </section>

        <section className="flex items-center justify-center p-6 sm:p-10 lg:p-14">
          <div className="w-full max-w-md">
            <div className="lg:hidden"><Image src="/new-hope-logo-horizontal.png" alt="New Hope Insurance" width={230} height={58} className="h-auto w-56 object-contain" priority /><p className="mt-2 text-xs font-semibold text-slate-400">Secure team access</p></div>
            <p className="mt-10 text-xs font-black uppercase tracking-[0.2em] text-[#4d6aa8] lg:mt-0">Welcome back</p>
            <h2 className="mt-2 text-3xl font-black tracking-tight text-[#17305f]">Sign in to your workspace</h2>
            <p className="mt-2 text-sm font-semibold text-slate-500">Use the username and password provided by management.</p>

            <form onSubmit={handleSubmit} className="mt-8 space-y-5">
              <label className="block"><span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-slate-500">Username</span><div className="flex items-center rounded-2xl border border-slate-200 bg-white px-4 focus-within:border-[#6b84b5] focus-within:ring-4 focus-within:ring-[#eef3fb]"><UserRound className="h-5 w-5 text-slate-400" /><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required className="min-w-0 flex-1 bg-transparent px-3 py-3.5 font-bold outline-none" placeholder="Username" /></div></label>
              <label className="block"><span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-slate-500">Password</span><div className="flex items-center rounded-2xl border border-slate-200 bg-white px-4 focus-within:border-[#6b84b5] focus-within:ring-4 focus-within:ring-[#eef3fb]"><LockKeyhole className="h-5 w-5 text-slate-400" /><input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required className="min-w-0 flex-1 bg-transparent px-3 py-3.5 font-bold outline-none" placeholder="Password" /><button type="button" onClick={() => setShowPassword((value) => !value)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></label>
              {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{error}</div> : null}
              <button disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#223f7a] px-4 py-3.5 font-black text-white transition hover:bg-[#17305f] disabled:cursor-wait disabled:opacity-60"><LogIn className="h-5 w-5" />{loading ? "Signing in..." : "Sign In"}</button>
            </form>
            <p className="mt-6 text-center text-xs font-semibold text-slate-400">New Hope Insurance Agency · Internal use only</p>
          </div>
        </section>
      </div>
    </div>
  );
}