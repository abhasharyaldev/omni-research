"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, Suspense, useState  } from "react";
import { apiPost, ApiError } from "@/lib/api";

function RegisterForm() {
  const router = useRouter();
  // local-mode-redirect: account-free installs go straight to the workspace.
  useEffect(() => {
    void fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d) => { if (d?.mode === "local") router.replace("/dashboard"); })
      .catch(() => undefined);
  }, [router]);
  const search = useSearchParams();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/auth/register", { displayName, email, password });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      router.push(search.get("next") ?? "/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm pt-12">
      <h1 className="mb-2 text-2xl font-bold">Create your account</h1>
      <p className="mb-6 text-sm" style={{ color: "var(--muted)" }}>
        Everything stays on your machine — accounts exist so multiple people can share one install
        without seeing each other&apos;s research.
      </p>
      <form className="panel space-y-4 p-5" onSubmit={submit}>
        <div>
          <label className="label" htmlFor="name">Display name</label>
          <input id="name" required maxLength={80} className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" required className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="password">Password (min 10 characters)</label>
          <input id="password" type="password" required minLength={10} className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="text-sm" style={{ color: "var(--bad)" }}>{error}</p>}
        <button className="btn btn-primary w-full justify-center" disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </button>
        <p className="text-center text-sm" style={{ color: "var(--muted)" }}>
          Already registered? <Link href="/login" className="underline">Sign in</Link>
        </p>
      </form>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
