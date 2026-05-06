import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import "./global.css";
import { Inter } from "next/font/google";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    template: "%s — the-brain",
    default: "the-brain — Cognitive OS for AI agents",
  },
  description:
    "Local-first, pluggable memory system for AI coding assistants. 3-layer cognitive architecture with graph memory, surprise-gated filtering, and local LoRA training.",
  metadataBase: new URL("https://the-brain.dev"),
  alternates: {
    canonical: "/docs",
  },
  openGraph: {
    title: "the-brain — Cognitive OS",
    description: "Local-first memory system for AI agents",
    url: "https://the-brain.dev",
    siteName: "the-brain",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={inter.className}>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
