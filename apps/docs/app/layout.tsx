import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import "./global.css";
import { Inter } from "next/font/google";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    template: "%s — archive",
    default: "the-brain — deprecated project archive",
  },
  description:
    "the-brain is a deprecated and archived local-first AI memory project. Source code and documentation are preserved for reference only.",
  metadataBase: new URL("https://the-brain.dev"),
  icons: {
    icon: "/favicon-32x32.png",
    shortcut: "/favicon-16x16.png",
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "the-brain — deprecated project archive",
    description: "Deprecated and archived local-first AI memory project. Source and documentation preserved for reference.",
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
