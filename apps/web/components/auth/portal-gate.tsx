"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Identity = {
  user: { name: string; email: string };
  portal: "super-admin" | "agency" | "client" | "selection";
  activeContext: { agencyName?: string; clientName?: string; role?: string } | null;
  redirectTo: string;
  supportMode?: { agencyName?: string } | null;
};

export default function PortalGate({ expected }: { expected: Exclude<Identity["portal"], "selection"> }) {
  const router = useRouter();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void fetch("/api/v1/auth/me", { credentials: "include" }).then(async (response) => {
      if (response.status === 401) { router.replace("/login"); return; }
      const data = await response.json() as Identity & { error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message ?? "Could not verify your session.");
      if (data.portal !== expected) { router.replace(data.redirectTo); return; }
      setIdentity(data);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not verify your session."));
  }, [expected, router]);

  async function signOut() {
    const csrfResponse = await fetch("/api/v1/auth/csrf", { credentials: "include" });
    if (!csrfResponse.ok) { setError("Could not prepare sign out."); return; }
    const { csrfToken } = await csrfResponse.json() as { csrfToken: string };
    const response = await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include", headers: { "X-CSRF-Token": csrfToken } });
    if (response.ok) router.replace("/login");
    else setError("Could not sign out. Please try again.");
  }

  if (error) return <main className="mx-auto max-w-3xl px-6 py-20"><p role="alert" className="text-rose-700">{error}</p></main>;
  if (!identity) return <main className="mx-auto max-w-3xl px-6 py-20"><p className="text-slate-600">Checking your session…</p></main>;

  const title = expected === "super-admin" ? "Super Admin portal" : expected === "agency" ? "Agency workspace" : "Client portal";
  const subtitle = identity.activeContext?.clientName ?? identity.activeContext?.agencyName ?? "AppZex";
  return (
    <main className="mx-auto max-w-4xl px-6 py-20">
      <div className="flex items-start justify-between gap-6">
        <div>
          <p className="text-sm font-bold tracking-[0.18em] text-indigo-700">APPZEX</p>
          <h1 className="mt-5 text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-slate-600">{subtitle} · signed in as {identity.user.name}</p>
        </div>
        <button onClick={() => void signOut()} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-white">Sign out</button>
      </div>
      {identity.supportMode && <aside role="status" className="mt-8 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">Support mode is active for {identity.supportMode.agencyName}. Acting as Super Admin: {identity.user.name}.</aside>}
      <section className="mt-10 rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="font-semibold">Workspace setup continues next</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">Your session and workspace membership are verified by the API. The portal’s project tools will be added in the following implementation phases.</p>
      </section>
    </main>
  );
}

