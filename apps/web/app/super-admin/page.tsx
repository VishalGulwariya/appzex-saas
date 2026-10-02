"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";

type Agency = { id: string; name: string; slug: string; status: "ACTIVE" | "SUSPENDED"; createdAt: string; _count?: { members: number; clients: number; projects: number } };
type Activity = { id: string; eventType: string; entityType: string; summary: string | null; createdAt: string; actor: { name: string }; agency?: { name: string } | null };
type Identity = { user: { name: string; email: string }; portal: string; redirectTo: string; supportMode: { id: string; agencyName: string } | null };
type Metrics = { totalAgencies: number; activeAgencies: number; suspendedAgencies: number; users: number; clients: number; projects: number; activeSupportSessions: number };

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message ?? "The request could not be completed.");
  return data;
}
async function csrfHeaders(): Promise<Record<string, string>> {
  const { csrfToken } = await json<{ csrfToken: string }>("/api/v1/auth/csrf");
  return { "X-CSRF-Token": csrfToken };
}
const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export default function SuperAdminPage() {
  const router = useRouter();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [selected, setSelected] = useState<(Agency & { supportSessions?: Array<{ id: string; reason: string; startedAt: string; endedAt: string | null; superAdmin: { name: string } }>; platformActivity?: Activity[] }) | null>(null);
  const [view, setView] = useState<"overview" | "agencies" | "activity">("overview");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [supportTarget, setSupportTarget] = useState<Agency | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [me, dashboard] = await Promise.all([
        json<Identity>("/api/v1/auth/me"),
        json<{ metrics: Metrics; recentActivity: Activity[] }>("/api/v1/admin/dashboard")
      ]);
      setIdentity(me); setMetrics(dashboard.metrics); setActivity(dashboard.recentActivity);
      const list = await json<{ items: Agency[]; pageCount: number }>(`/api/v1/admin/agencies?page=${page}&pageSize=10${query ? `&q=${encodeURIComponent(query)}` : ""}${status ? `&status=${status}` : ""}`);
      setAgencies(list.items); setPageCount(Math.max(1, list.pageCount));
    } catch (cause) { const message = cause instanceof Error ? cause.message : "Could not load the admin portal."; setError(message); }
  }, [page, query, status]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (view === "activity") { void json<{ items: Activity[] }>("/api/v1/admin/activity?page=1&pageSize=100").then((data) => setActivity(data.items)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not load platform activity.")); } }, [view]);
  useEffect(() => { if (identity?.portal && identity.portal !== "super-admin") router.replace(identity.redirectTo); }, [identity, router]);

  async function runAction(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Action failed."); }
    finally { setBusy(false); }
  }
  async function openDetails(agency: Agency) {
    try { const data = await json<{ agency: typeof selected }>(`/api/v1/admin/agencies/${agency.id}`); setSelected(data.agency); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load agency details."); }
  }
  async function createAgency(form: FormData) {
    await runAction(async () => {
      await json("/api/v1/admin/agencies", { method: "POST", headers: await csrfHeaders(), body: JSON.stringify({ name: form.get("name"), slug: form.get("slug") }) });
      setCreateOpen(false); setNotice("Agency created."); setPage(1);
    });
  }
  async function startSupport(form: FormData) {
    if (!supportTarget) return;
    await runAction(async () => {
      await json(`/api/v1/admin/agencies/${supportTarget.id}/support-sessions`, { method: "POST", headers: await csrfHeaders(), body: JSON.stringify({ reason: form.get("reason") }) });
      setSupportTarget(null); router.push("/agency");
    });
  }
  async function endSupport() {
    if (!identity?.supportMode) return;
    const supportSessionId = identity.supportMode.id;
    await runAction(async () => {
      await json(`/api/v1/admin/support-sessions/${supportSessionId}`, { method: "DELETE", headers: await csrfHeaders() });
      setNotice("Support mode ended.");
    });
  }
  async function signOut() {
    await runAction(async () => { await json("/api/v1/auth/logout", { method: "POST", headers: await csrfHeaders() }); router.replace("/login"); });
  }

  if (!identity) return <main className="min-h-screen bg-slate-50 p-8 text-slate-600">Loading Super Admin portalx{error && <p role="alert" className="mt-3 text-rose-700">{error}</p>}</main>;
  return <main className="min-h-screen bg-[#f5f6fa] text-slate-900">
    <header className="border-b border-slate-200 bg-white"><div className="mx-auto flex max-w-[1440px] items-center justify-between px-6 py-4 lg:px-10"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-700 text-lg font-black text-white">A</div><div><p className="text-sm font-black tracking-[.16em] text-indigo-700">APPZEX</p><p className="text-xs text-slate-500">Platform operations</p></div></div><div className="flex items-center gap-4"><div className="hidden text-right sm:block"><p className="text-sm font-semibold">{identity.user.name}</p><p className="text-xs text-slate-500">Super Admin</p></div><button onClick={() => void signOut()} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold hover:bg-slate-50">Sign out</button></div></div></header>
    <div className="mx-auto max-w-[1440px] px-6 py-8 lg:px-10">
      {identity.supportMode && <aside role="status" data-testid="support-mode-banner" className="mb-6 flex flex-col justify-between gap-3 rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 sm:flex-row sm:items-center"><div><p className="font-bold text-amber-950">Viewing {identity.supportMode.agencyName} in Super Admin Support Mode</p><p className="mt-1 text-sm text-amber-900">Signed in as Super Admin {identity.user.name}. Every action in the agency workspace is written to the platform audit log.</p></div><button disabled={busy} onClick={() => void endSupport()} className="rounded-lg bg-amber-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">Exit Support Mode</button></aside>}
      <div className="mb-7 flex flex-col justify-between gap-4 md:flex-row md:items-end"><div><p className="text-sm font-semibold text-indigo-700">PLATFORM CONTROL</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Super Admin</h1><p className="mt-2 text-slate-500">Manage agencies, monitor platform activity, and provide audited support.</p></div><div className="flex gap-2">{(["overview", "agencies", "activity"] as const).map((key) => <button key={key} onClick={() => setView(key)} className={`rounded-lg px-4 py-2 text-sm font-semibold capitalize ${view === key ? "bg-indigo-700 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>{key}</button>)}</div></div>
      {error && <div role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}{notice && <div role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div>}
      {view === "overview" && <><section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[["Agencies", metrics?.totalAgencies, `${metrics?.activeAgencies ?? 0} active`], ["Suspended", metrics?.suspendedAgencies, "Agencies currently paused"], ["Users", metrics?.users, "Across the platform"], ["Clients", metrics?.clients, "Across agencies"], ["Projects", metrics?.projects, "Across all agencies"], ["Active support", metrics?.activeSupportSessions, "Open support sessions"]].map(([label, value, sub]) => <article key={String(label)} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-medium text-slate-500">{label}</p><p className="mt-3 text-3xl font-bold">{value ?? "-"}</p><p className="mt-1 text-xs text-slate-500">{sub}</p></article>)}</section><section className="mt-7 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-bold">Recent platform activity</h2><p className="text-sm text-slate-500">Administrative events and support sessions</p></div><button onClick={() => setView("activity")} className="text-sm font-semibold text-indigo-700">View all</button></div><ActivityList items={activity.slice(0, 6)} /></section></>}
      {view === "agencies" && <section className="rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-col justify-between gap-3 border-b border-slate-100 p-5 md:flex-row md:items-center"><div><h2 className="text-lg font-bold">Agencies</h2><p className="text-sm text-slate-500">Search, inspect, and manage tenant access.</p></div><button onClick={() => setCreateOpen(true)} className="rounded-lg bg-indigo-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-indigo-800">+ Create agency</button></div><div className="flex flex-col gap-3 p-5 sm:flex-row"><input aria-label="Search agencies" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="Search name or slug" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-500 sm:max-w-sm"/><select aria-label="Filter agency status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"><option value="">All statuses</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option></select></div><div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Agency</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Members</th><th className="px-5 py-3">Clients</th><th className="px-5 py-3">Projects</th><th className="px-5 py-3">Created</th><th className="px-5 py-3"> </th></tr></thead><tbody className="divide-y divide-slate-100">{agencies.map((agency) => <tr key={agency.id} className="hover:bg-slate-50"><td className="px-5 py-4"><button onClick={() => void openDetails(agency)} className="text-left font-bold text-slate-900 hover:text-indigo-700">{agency.name}<span className="mt-1 block font-normal text-slate-500">/{agency.slug}</span></button></td><td className="px-5 py-4"><Status status={agency.status}/></td><td className="px-5 py-4">{agency._count?.members ?? 0}</td><td className="px-5 py-4">{agency._count?.clients ?? 0}</td><td className="px-5 py-4">{agency._count?.projects ?? 0}</td><td className="px-5 py-4 text-slate-500">{date(agency.createdAt)}</td><td className="px-5 py-4"><button onClick={() => setSupportTarget(agency)} className="font-semibold text-indigo-700 hover:underline">Support</button></td></tr>)}{agencies.length === 0 && <tr><td colSpan={7} className="px-5 py-12 text-center text-slate-500">No agencies match those filters.</td></tr>}</tbody></table></div><div className="flex items-center justify-between border-t border-slate-100 p-4 text-sm text-slate-500"><span>Page {page} of {pageCount}</span><div className="flex gap-2"><button disabled={page <= 1} onClick={() => setPage((value) => value - 1)} className="rounded-md border px-3 py-1.5 disabled:opacity-40">Previous</button><button disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)} className="rounded-md border px-3 py-1.5 disabled:opacity-40">Next</button></div></div></section>}
      {view === "activity" && <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="text-lg font-bold">Platform activity</h2><p className="mb-5 text-sm text-slate-500">Audited administrative actions and support session lifecycle.</p><ActivityList items={activity} /></section>}
    </div>
    {selected && <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/30" onClick={() => setSelected(null)}><aside onClick={(e) => e.stopPropagation()} className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-2xl"><div className="flex items-start justify-between"><div><p className="text-sm font-semibold text-indigo-700">AGENCY DETAILS</p><h2 className="mt-1 text-2xl font-bold">{selected.name}</h2><p className="text-sm text-slate-500">/{selected.slug}</p></div><button aria-label="Close details" onClick={() => setSelected(null)} className="rounded-lg border px-3 py-1.5">x</button></div><div className="mt-5 flex items-center justify-between"><Status status={selected.status}/><button disabled={busy} onClick={() => void runAction(async () => { const next = selected.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE"; if (next === "SUSPENDED" && !window.confirm(`Suspend ${selected.name}? Agency members will lose workspace access.`)) return; await json(`/api/v1/admin/agencies/${selected.id}/status`, { method: "PATCH", headers: await csrfHeaders(), body: JSON.stringify({ status: next }) }); setSelected(null); setNotice(next === "ACTIVE" ? "Agency reactivated." : "Agency suspended."); })} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold">{selected.status === "ACTIVE" ? "Suspend agency" : "Reactivate agency"}</button></div><div className="mt-6 grid grid-cols-3 gap-3">{[["Members", selected._count?.members], ["Clients", selected._count?.clients], ["Projects", selected._count?.projects]].map(([label, value]) => <div key={String(label)} className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-xl font-bold">{value ?? 0}</p></div>)}</div><button onClick={() => setSupportTarget(selected)} className="mt-5 w-full rounded-lg bg-indigo-700 px-4 py-3 text-sm font-bold text-white">Enter support mode</button><h3 className="mt-8 font-bold">Recent support sessions</h3><div className="mt-3 space-y-3">{selected.supportSessions?.length ? selected.supportSessions.map((session) => <div key={session.id} className="rounded-xl border p-3 text-sm"><p className="font-semibold">{session.superAdmin.name} x {session.endedAt ? "Ended" : "Active"}</p><p className="mt-1 text-slate-500">{session.reason}</p><p className="mt-1 text-xs text-slate-400">{date(session.startedAt)}{session.endedAt ? ` x ${date(session.endedAt)}` : ""}</p></div>) : <p className="text-sm text-slate-500">No support sessions recorded.</p>}</div><h3 className="mt-8 font-bold">Agency activity</h3><div className="mt-3"><ActivityList items={(selected.platformActivity ?? []).map((entry) => ({ ...entry, agency: { name: selected.name } }))}/></div></aside></div>}
    {createOpen && <Modal title="Create agency" close={() => setCreateOpen(false)}><form action={(form) => void createAgency(form)} className="space-y-4"><Field name="name" label="Agency name" placeholder="Northstar Studio"/><Field name="slug" label="URL slug" placeholder="northstar-studio"/><p className="text-xs text-slate-500">A workspace and default UTC settings will be created.</p><ModalButtons busy={busy} close={() => setCreateOpen(false)} submit="Create agency"/></form></Modal>}
    {supportTarget && <Modal title={`Enter support mode x ${supportTarget.name}`} close={() => setSupportTarget(null)}><form action={(form) => void startSupport(form)} className="space-y-4"><div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">Your name, agency, reason, start and end times will be recorded. Support access will be clearly marked while active.</div><label className="block text-sm font-semibold">Reason<textarea name="reason" minLength={10} maxLength={500} required rows={4} placeholder="Describe the issue you are helping resolvex" className="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 font-normal"/></label><ModalButtons busy={busy} close={() => setSupportTarget(null)} submit="Start support session"/></form></Modal>}
  </main>;
}
function Status({ status }: { status: "ACTIVE" | "SUSPENDED" }) { return <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${status === "ACTIVE" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{status === "ACTIVE" ? "Active" : "Suspended"}</span>; }
function ActivityList({ items }: { items: Activity[] }) { return <div className="divide-y divide-slate-100">{items.length ? items.map((item) => <div key={item.id} className="flex gap-3 py-3"><div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-indigo-500"/><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{item.summary ?? item.eventType}</p><p className="mt-1 text-xs text-slate-500">{item.actor?.name ?? "System"}{item.agency?.name ? ` x ${item.agency.name}` : ""} x {date(item.createdAt)}</p></div></div>) : <p className="py-8 text-center text-sm text-slate-500">No platform activity yet.</p>}</div>; }
function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) { return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4" onClick={close}><section role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"><div className="mb-5 flex items-center justify-between"><h2 className="text-xl font-bold">{title}</h2><button onClick={close} aria-label="Close" className="rounded-lg border px-3 py-1">x</button></div>{children}</section></div>; }
function Field({ name, label, placeholder }: { name: string; label: string; placeholder: string }) { return <label className="block text-sm font-semibold">{label}<input name={name} required minLength={2} maxLength={name === "slug" ? 100 : 160} placeholder={placeholder} className="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 font-normal outline-none focus:border-indigo-500"/></label>; }
function ModalButtons({ busy, close, submit }: { busy: boolean; close: () => void; submit: string }) { return <div className="flex justify-end gap-2 pt-2"><button type="button" onClick={close} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold">Cancel</button><button disabled={busy} type="submit" className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">{submit}</button></div>; }






