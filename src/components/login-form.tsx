"use client";

import { Eye, EyeOff, LockKeyhole, LogIn, UserRound } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { FormEvent, KeyboardEvent, useState } from "react";

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
    if (loading) return;

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

  function submitFromPassword(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#eef2f7] px-4 py-8 text-slate-950">
      <div className="w-full max-w-md">
        <section className="overflow-hidden rounded-[30px] border border-[#d9e1ed] bg-white shadow-2xl shadow-slate-300/50">
          <div className="border-b border-slate-100 bg-[#f7f9fc] px-6 py-7 text-center sm:px-8">
            <Image src="/new-hope-logo-horizontal.png" alt="New Hope Insurance" width={240} height={60} className="mx-auto h-auto w-56 object-contain" priority />
          </div>

          <div className="px-6 py-7 sm:px-8 sm:py-8">
            <div className="text-center">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-[#4d6aa8]">New Hope Work Desk</p>
              <h1 className="mt-2 text-2xl font-black tracking-tight text-[#17305f]">Sign in</h1>
              <p className="mt-2 text-sm font-semibold text-slate-500">Enter your assigned username and password.</p>
            </div>

            <form onSubmit={handleSubmit} className="mt-7 space-y-4">
              <label className="block">
                <span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-slate-500">Username</span>
                <div className="flex items-center rounded-2xl border border-slate-200 bg-white px-4 focus-within:border-[#6b84b5] focus-within:ring-4 focus-within:ring-[#eef3fb]">
                  <UserRound className="h-5 w-5 text-slate-400" />
                  <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required className="min-w-0 flex-1 bg-transparent px-3 py-3.5 font-bold outline-none" placeholder="Username" />
                </div>
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-slate-500">Password</span>
                <div className="flex items-center rounded-2xl border border-slate-200 bg-white px-4 focus-within:border-[#6b84b5] focus-within:ring-4 focus-within:ring-[#eef3fb]">
                  <LockKeyhole className="h-5 w-5 text-slate-400" />
                  <input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={submitFromPassword} autoComplete="current-password" required className="min-w-0 flex-1 bg-transparent px-3 py-3.5 font-bold outline-none" placeholder="Password" />
                  <button type="button" onClick={() => setShowPassword((value) => !value)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                </div>
              </label>

              {error ? <div role="alert" aria-live="polite" className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{error}</div> : null}

              <button type="submit" disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#223f7a] px-4 py-3.5 font-black text-white transition hover:bg-[#17305f] disabled:cursor-wait disabled:opacity-60">
                <LogIn className="h-5 w-5" />
                {loading ? "Signing in..." : "Sign In"}
              </button>
            </form>

            <p className="mt-5 text-center text-xs font-semibold text-slate-400">Press Enter after typing your password.</p>
          </div>
        </section>
        <p className="mt-4 text-center text-xs font-semibold text-slate-400">New Hope Insurance Agency · Internal use only</p>
      </div>
    </main>
  );
}
