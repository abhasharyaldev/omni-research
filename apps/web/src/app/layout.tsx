import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Nav } from "@/components/nav";

export const metadata: Metadata = {
  title: "OmniResearch",
  description:
    "Local-first research, learning, and news assistant with verifiable citations, powered by Crawlee.",
};

const themeInit = `
try {
  const saved = localStorage.getItem("omni-theme");
  const dark = saved === "dark" || ((!saved || saved === "system") && window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (dark) document.documentElement.classList.add("dark");
} catch {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-screen antialiased">
        <Providers>
          <Nav />
          <main className="mx-auto max-w-6xl px-4 pb-20 pt-6">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
