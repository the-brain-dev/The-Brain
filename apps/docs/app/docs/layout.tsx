import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <div
        role="status"
        className="border-b border-red-500/40 bg-red-950/25 px-4 py-3 text-sm text-red-200 md:px-6"
      >
        <div className="mx-auto flex max-w-screen-xl flex-col gap-1 md:flex-row md:items-baseline md:gap-3">
          <strong className="font-semibold tracking-wide">DEPRECATED — PROJECT ARCHIVED</strong>
          <span>the-brain is no longer maintained. Source and documentation are preserved for reference only.</span>
        </div>
      </div>
      <DocsLayout tree={source.pageTree} {...baseOptions()}>
        {children}
      </DocsLayout>
    </>
  );
}
