"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { VT323 } from "next/font/google";

const vt323 = VT323({ weight: "400", subsets: ["latin"] });

export default function Home() {
  const [bootOpacity, setBootOpacity] = useState<string[]>([
    "opacity-0",
    "opacity-0",
    "opacity-0",
    "opacity-0",
  ]);

  useEffect(() => {
    // Boot sequence
    const delays = [200, 800, 1500, 2200];
    const timers = delays.map((delay, index) =>
      window.setTimeout(() => {
        setBootOpacity((previous) => {
          const next = [...previous];
          next[index] = "opacity-100";
          return next;
        });
      }, delay),
    );

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);

  return (
    <main className={`min-h-screen bg-black text-[#39ff14] relative overflow-hidden ${vt323.className}`}>
      {/* CRT overlay effects */}
      <div className="pointer-events-none fixed inset-0 z-50" style={{
        background: "repeating-linear-gradient(transparent, transparent 3px, rgba(57,255,20,0.07) 3px, rgba(57,255,20,0.07) 4px)",
      }} />
      <div className="pointer-events-none fixed inset-0 z-40" style={{
        background: "linear-gradient(rgba(57,255,20,0.03), transparent 18%, transparent 82%, rgba(0,255,245,0.025))",
        animation: "crt-flicker 1.6s infinite alternate",
      }} />
      <div className="pointer-events-none fixed inset-0 z-30" style={{
        background: "repeating-linear-gradient(transparent, transparent 6px, rgba(0,255,245,0.035) 7px, rgba(0,255,245,0.035) 8px)",
        animation: "rain-fall 1.2s linear infinite",
        backgroundSize: "100% 800px",
      }} />

      {/* Content */}
      <div className="relative z-10 flex items-center justify-center min-h-screen px-6">
        <div className="max-w-[880px] w-full" style={{
          textShadow: "0 0 6px #39ff14, 0 0 12px #39ff14, 0 0 24px #39ff14",
        }}>

          {/* Boot Sequence */}
          <div className="mb-4 sm:mb-8 font-mono text-sm opacity-75 tracking-wider">
            <div className={"transition-opacity duration-300 " + bootOpacity[0]}>
              THE-BRAIN 1.1 - ARCHIVE BUILD
            </div>
            <div className={"transition-opacity duration-300 " + bootOpacity[1]}>
              LOADING PROJECT ARCHIVE...
            </div>
            <div className={"transition-opacity duration-300 " + bootOpacity[2]}>
              SOURCE PRESERVED...
            </div>
            <div className={"transition-opacity duration-300 " + bootOpacity[3]}>
              NO ACTIVE MAINTENANCE
            </div>
          </div>

          {/* Title */}
          <div className="mb-6 sm:mb-10">
            <div className="font-bold text-5xl sm:text-7xl tracking-[-2px] mb-1">
              THE-BRAIN
            </div>
            <div className="text-[#00fff5] text-xl sm:text-2xl tracking-[4px] sm:tracking-[6px] -mt-2" style={{
              textShadow: "0 0 8px #00fff5",
            }}>
              REFERENCE ARCHIVE
            </div>
          </div>

          {/* Copy */}
          <div className="mb-6 sm:mb-10 max-w-[620px]">
            <div className="text-[1.45rem] leading-tight mb-4">
              A preserved project.<br />
              A reference archive.
            </div>

            <div className="text-[#39ff14]/70 text-[1.35rem] leading-snug">
              the-brain is deprecated and no longer maintained.<br /><br />
              Source code and documentation remain available for reference only.
            </div>
          </div>

          {/* Archive status */}
          <div className="mb-6 sm:mb-9 border-2 border-[#ff4444] bg-[#1a0000] p-4 max-w-[620px]" style={{
            boxShadow: "0 0 15px rgba(255,68,68,0.2)",
          }}>
            <div className="text-[#ff4444] text-[1.1rem] tracking-[2px] mb-1" style={{
              textShadow: "0 0 6px #ff4444",
            }}>
              DEPRECATED — PROJECT ARCHIVED
            </div>
            <div className="text-[#ff6666]/80 text-[0.95rem] leading-snug">
              Do not install or use the-brain for new projects. No active maintenance or support is planned.
            </div>
          </div>

          {/* CTA */}
          <div className="flex flex-wrap gap-x-4 gap-y-3 mb-8 sm:mb-12">
            <Link
              href="/docs"
              className="text-[1.45rem] bg-transparent border-3 border-[#39ff14] text-[#39ff14] py-3.5 px-10 uppercase tracking-[1.5px] hover:bg-[#39ff14] hover:text-black hover:shadow-[0_0_25px_#39ff14] transition-all no-underline inline-block"
              style={{ fontFamily: "'VT323', monospace" }}
            >
              &gt; ENTER THE ARCHIVE
            </Link>
            <a
              href="https://github.com/the-brain-dev/The-Brain"
              target="_blank"
              className="text-[1.45rem] bg-transparent border-3 border-[#39ff14] text-[#39ff14] py-3.5 px-10 uppercase tracking-[1.5px] hover:bg-[#39ff14] hover:text-black hover:shadow-[0_0_25px_#39ff14] transition-all no-underline inline-block"
              style={{ fontFamily: "'VT323', monospace" }}
              rel="noreferrer"
            >
              &gt; SOURCE CODE
            </a>
          </div>

        </div>
      </div>

      {/* Status bar */}
      <div className="fixed bottom-4 left-0 right-0 px-4 sm:bottom-7 sm:px-8 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-xs font-mono text-[#39ff14]/50 z-10">
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <div>STATUS: <span className="text-[#ff6666]">ARCHIVED</span></div>
          <div>SOURCE: <span className="text-[#00fff5]">REFERENCE ONLY</span></div>
        </div>
        <div className="text-[#00fff5]">MAINTENANCE: STOPPED</div>
      </div>
    </main>
  );
}
