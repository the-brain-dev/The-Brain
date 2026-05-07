import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import "./global.css";
import { Inter } from "next/font/google";
import PasswordGate from "../components/PasswordGate";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    template: "%s — the-brain",
    default: "the-brain — open memory platform for AI",
  },
  description:
    "An open memory platform for AI, in the making. 3-layer cognitive architecture, local-first, entirely pluggable. Research project — contribute, fork, or build an extension.",
  metadataBase: new URL("https://the-brain.dev"),
  openGraph: {
    title: "the-brain — open memory platform for AI",
    description: "3-layer cognitive architecture. Local-first, pluggable. Research project.",
    url: "https://the-brain.dev",
    siteName: "the-brain",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={inter.className}>
      <body className="flex flex-col min-h-screen">
        <PasswordGate>
          <RootProvider>{children}</RootProvider>
        </PasswordGate>
      </body>
    </html>
  );
}
