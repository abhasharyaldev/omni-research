"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "@/lib/api";
import { useUiStore, type ThemeChoice } from "@/lib/store";
import { useEffect, useState } from "react";
import { GlobalSearchPalette } from "./global-search";

const THEME_CYCLE: ThemeChoice[] = ["light", "dark", "system"];
const THEME_ICON: Record<ThemeChoice, string> = { light: "Light", dark: "Dark", system: "Auto" };

const SHORTCUTS: [string, string][] = [
  ["Ctrl/Cmd + K", "Global search across all projects"],
  ["Ctrl/Cmd + F", "Find inside the open report"],
  ["Enter / Shift+Enter", "Next / previous match (in report find)"],
  ["J / K", "Next / previous citation (report page)"],
  ["Esc", "Close the active dialog or drawer"],
  ["?", "Show this shortcut help"],
];

export function Nav() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { theme, setTheme } = useUiStore();
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("omni-theme") as ThemeChoice | null;
    if (saved && THEME_CYCLE.includes(saved)) {
      useUiStore.setState({ theme: saved });
    }
  }, []);

  // "?" opens shortcut help (never while typing).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (event.key === "?" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setHelpOpen((o) => !o);
      }
      if (event.key === "Escape") setHelpOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { data } = useQuery({
    queryKey: ["me"],
    queryFn: () => apiGet<{ user: { displayName: string } | null; mode?: string }>("/api/auth/me"),
    retry: false,
  });
  const user = data?.user;
  const localMode = data?.mode === "local";

  const cycleTheme = () => {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]!;
    setTheme(next);
  };

  return (
    <header className="sticky top-0 z-30 border-b" style={{ borderColor: "var(--line)", background: "var(--panel)" }}>
      <div className="mx-auto flex max-w-6xl items-center gap-5 px-4 py-3">
        <Link href="/" className="text-lg font-bold tracking-tight">
          Omni<span style={{ color: "var(--accent)" }}>Research</span>
        </Link>
        {user && (
          <nav className="flex items-center gap-4 text-sm font-medium" style={{ color: "var(--muted)" }}>
            <Link href="/dashboard" className="hover:underline">Dashboard</Link>
            <Link href="/projects/new" className="hover:underline">New project</Link>
            <Link href="/search" className="hover:underline">Search</Link>
            <Link href="/settings" className="hover:underline">Settings</Link>
          </nav>
        )}
        <div className="ml-auto flex items-center gap-3">
          {user && (
            <Link href="/search" className="btn" title="Global search (Ctrl/Cmd+K)">
              Search <kbd>Ctrl K</kbd>
            </Link>
          )}
          <button className="btn" aria-label={`Theme: ${theme}`} title="Cycle light / dark / system" onClick={cycleTheme}>
            {THEME_ICON[theme]}
          </button>
          {user ? (
            <>
              <span className="text-sm" style={{ color: "var(--muted)" }}>{user.displayName}</span>
              {localMode ? (
                <span className="badge" title="Account-free local mode: everything stays on this machine">local</span>
              ) : (
                <button
                  className="btn"
                  onClick={async () => {
                    await apiPost("/api/auth/logout");
                    await queryClient.invalidateQueries();
                    router.push("/");
                  }}
                >
                  Sign out
                </button>
              )}
            </>
          ) : (
            <>
              <Link href="/login" className="btn">Sign in</Link>
              <Link href="/register" className="btn btn-primary">Create account</Link>
            </>
          )}
        </div>
      </div>
      <GlobalSearchPalette />
      {helpOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setHelpOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
        >
          <div className="panel w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="font-bold">Keyboard shortcuts</h2>
              <button className="btn" onClick={() => setHelpOpen(false)}>Close</button>
            </div>
            <dl className="mt-4 space-y-2 text-sm">
              {SHORTCUTS.map(([keys, description]) => (
                <div key={keys} className="flex items-center justify-between gap-4">
                  <dt><kbd>{keys}</kbd></dt>
                  <dd style={{ color: "var(--muted)" }}>{description}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </header>
  );
}
