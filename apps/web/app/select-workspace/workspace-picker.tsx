"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Workspace =
  | { type: "agency"; agencyId: string; agencyName: string; role: string }
  | { type: "client"; agencyId: string; agencyName: string; clientId: string; clientName: string; clientMembershipId: string };

export default function WorkspacePicker() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [csrfToken, setCsrfToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    void Promise.all([
      fetch("/api/v1/auth/me", { credentials: "include" }),
      fetch("/api/v1/auth/csrf", { credentials: "include" })
    ]).then(async ([meResponse, csrfResponse]) => {
      if (meResponse.status === 401) { router.replace("/login"); return; }
      const me = await meResponse.json() as { contexts?: Workspace[]; redirectTo?: string };
      if (!meResponse.ok) throw new Error("Could not load workspace memberships.");
      if (!me.contexts?.length) { router.replace(me.redirectTo ?? "/login"); return; }
      if (!me.contexts || me.contexts.length === 0) { setWorkspaces([]); return; }
      if (!csrfResponse.ok) throw new Error("Could not prepare secure workspace selection.");
      const csrf = await csrfResponse.json() as { csrfToken: string };
      setWorkspaces(me.contexts);
      setCsrfToken(csrf.csrfToken);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to load workspaces."));
  }, [router]);

  async function choose(workspace: Workspace) {
    const key = workspace.type === "agency" ? workspace.agencyId : workspace.clientMembershipId;
    setBusy(key);
    setError("");
    try {
      const response = await fetch("/api/v1/auth/context", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(workspace.type === "agency"
          ? { type: "agency", agencyId: workspace.agencyId }
          : { type: "client", clientMembershipId: workspace.clientMembershipId })
      });
      const result = await response.json() as { redirectTo?: string; error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "Could not select workspace.");
      router.replace(result.redirectTo ?? "/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not select workspace.");
      setBusy("");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-5 py-16">
      <p className="text-sm font-bold tracking-[0.18em] text-indigo-700">APPZEX</p>
      <h1 className="mt-5 text-3xl font-semibold tracking-tight">Choose a workspace</h1>
      <p className="mt-2 text-slate-600">Your account belongs to more than one workspace. Choose where to continue.</p>
      {error && <p role="alert" className="mt-5 rounded-xl bg-rose-50 p-4 text-sm text-rose-700">{error}</p>}
      <ul className="mt-8 space-y-3">
        {workspaces.map((workspace) => {
          const key = workspace.type === "agency" ? workspace.agencyId : workspace.clientMembershipId;
          const title = workspace.type === "agency" ? workspace.agencyName : workspace.clientName;
          const subtitle = workspace.type === "agency" ? `${workspace.role} · ${workspace.agencyName}` : `Client workspace · ${workspace.agencyName}`;
          return (
            <li key={`${workspace.type}:${key}`}>
              <button type="button" onClick={() => void choose(workspace)} disabled={!csrfToken || Boolean(busy)} className="w-full rounded-2xl border border-slate-200 bg-white p-5 text-left transition hover:border-indigo-400 hover:shadow-sm disabled:opacity-50">
                <span className="block font-semibold text-slate-900">{title}</span>
                <span className="mt-1 block text-sm text-slate-600">{subtitle}</span>
                {busy === key && <span className="mt-2 block text-sm text-indigo-700">Opening…</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
