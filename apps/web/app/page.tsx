import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-20">
      <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-700">AppZex</p>
      <h1 className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">Agency work, in one place.</h1>
      <p className="mt-5 max-w-xl text-lg leading-8 text-slate-600">Sign in to open an agency or client workspace.</p>
      <Link href="/login" className="mt-8 inline-flex w-fit rounded-xl bg-indigo-700 px-5 py-3 font-semibold text-white transition hover:bg-indigo-800">Sign in</Link>
    </main>
  );
}
