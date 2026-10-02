import Link from "next/link";
import LoginForm from "./login-form";

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-14">
      <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-8 shadow-sm sm:p-10">
        <Link href="/" className="text-sm font-bold tracking-[0.18em] text-indigo-700">APPZEX</Link>
        <h1 className="mt-8 text-3xl font-semibold tracking-tight text-slate-950">Welcome back</h1>
        <p className="mt-2 text-slate-600">Sign in to open your project workspace.</p>
        <LoginForm />
      </section>
    </main>
  );
}
