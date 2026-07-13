"use client";

import { create } from "zustand";

/** Lightweight client-only state (theme). Server state lives in TanStack Query. */
export type ThemeChoice = "light" | "dark" | "system";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(choice: ThemeChoice): void {
  if (typeof document === "undefined") return;
  const dark = choice === "dark" || (choice === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
  window.localStorage.setItem("omni-theme", choice);
}

type UiState = {
  theme: ThemeChoice;
  setTheme: (theme: ThemeChoice) => void;
};

export const useUiStore = create<UiState>((set) => ({
  theme: "system",
  setTheme: (theme) => {
    set({ theme });
    applyTheme(theme);
  },
}));
