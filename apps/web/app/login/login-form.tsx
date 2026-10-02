"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type ApiError = { error?: { message?: string } };

export default function LoginForm() {
  const router = useRouter();
  const [csrfToken, setCsrfToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void fetch("/api/v1/auth/csrf", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Sign-in is temporarily unavailable.");
        const data = await response.json() as { csrfToken: string };
        setCsrfToken(data.csrfToken);
      })
      .catch(() => setError("Could not connect to the sign-in service. Please try again."));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ email, password })
      });
      const data = await response.json() as { redirectTo?: string } & ApiError;
      if (!response.ok) throw new Error(data.error?.message ?? "Sign-in failed.");
      router.replace(data.redirectTo ?? "/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-8 space-y-5">
      <div>
        <label htmlFor="email" className="mb-2 block text-sm font-medium text-slate-700">Email address</label>
        <input id="email" name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 outline-none transition focus:border-indigo-600 focus:ring-4 focus:ring-indigo-100" />
      </div>
      <div>
        <label htmlFor="password" className="mb-2 block text-sm font-medium text-slate-700">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 outline-none transition focus:border-indigo-600 focus:ring-4 focus:ring-indigo-100" />
      </div>
      {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      <button type="submit" disabled={!csrfToken || loading} className="w-full rounded-xl bg-indigo-700 px-4 py-3 font-semibold text-white transition hover:bg-indigo-800 disabled:cursor-not-allowed disabled:opacity-50">
        {loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
