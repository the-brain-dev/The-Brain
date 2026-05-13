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
  const [memoryCount, setMemoryCount] = useState<number>(0);

  useEffect(() => {
    // Randomize on client only (avoid hydration mismatch)
    setMemoryCount(Math.floor(Math.random() * 90) + 40);

    // Boot sequence
    const delays = [200, 800, 1500, 2200];
    const newOpacities = [...bootOpacity];
    delays.forEach((delay, i) => {
      setTimeout(() => {
        newOpacities[i] = "opacity-100";
        setBootOpacity([...newOpacities]);
      }, delay);
    });

    // Dynamic memory count
    const interval = setInterval(() => {
      setMemoryCount((prev) => {
        const change = Math.floor(Math.random() * 4) + 1;
        const direction = Math.random() > 0.5 ? 1 : -1;
        return Math.max(12, Math.min(180, prev + change * direction));
      });
    }, Math.random() * 5500 + 7200);

    return () => clearInterval(interval);
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
          <div className="mb-8 font-mono text-sm opacity-75 tracking-wider">
            <div className={"transition-opacity duration-300 " + bootOpacity[0]}>
              THE-BRAIN 1.1 - BUILD 204912
            </div>
            <div className={"transition-opacity duration-300 " + bootOpacity[1]}>
              INITIALIZING MEMORY CORE...
            </div>
            <div className={"transition-opacity duration-300 " + bootOpacity[2]}>
              LOADING GRAPH LAYER...
            </div>
            <div className={"transition-opacity duration-300 " + bootOpacity[3]}>
              SPM ENGINE ONLINE
            </div>
          </div>

          {/* Title */}
          <div className="mb-10">
            <div className="font-bold text-7xl tracking-[-2px] mb-1">
              THE-BRAIN
            </div>
            <div className="text-[#00fff5] text-2xl tracking-[6px] -mt-2" style={{
              textShadow: "0 0 8px #00fff5",
            }}>
              RECLAIM YOUR MIND
            </div>
          </div>

          {/* Copy */}
          <div className="mb-10 max-w-[620px]">
            <div className="text-[1.45rem] leading-tight mb-4">
              Three layers.<br />
              One promise.
            </div>

            <div className="text-[#39ff14]/70 text-[1.35rem] leading-snug">
              Instant &rarr; Selection &rarr; Deep.<br /><br />
              What happens now.<br />
              What&apos;s worth keeping.<br />
              What becomes permanent.<br /><br />
              All replaceable.<br />
              All local.
            </div>
          </div>

          {/* Install Command */}
          <div className="mb-9">
            <div className="text-[1.1rem] tracking-[4px] text-[#39ff14]/60 mb-2.5">
              BOOT COMMAND
            </div>
            <div className="bg-[#00110a] border-3 border-[#39ff14] p-5 text-[1.28rem] shadow-[0_0_20px_rgba(57,255,20,0.25)]" style={{ wordBreak: "break-word" }}>
              <span className="text-[#39ff14]/60">$</span> curl -fsSL https://raw.githubusercontent.com/the-brain-dev/The-Brain/main/install.sh | bash
            </div>
            <div className="text-xs text-[#39ff14]/40 mt-1.5 ml-1">
              Requires: Bun + uv (macOS / Linux)
            </div>
          </div>

          {/* Warning */}
          <div className="mb-9 border-2 border-[#ff4444] bg-[#1a0000] p-4 max-w-[620px]" style={{
            boxShadow: "0 0 15px rgba(255,68,68,0.2)",
          }}>
            <div className="text-[#ff4444] text-[1.1rem] tracking-[2px] mb-1" style={{
              textShadow: "0 0 6px #ff4444",
            }}>
              ⚠ EXPERIMENTAL — DO NOT USE IN PRODUCTION
            </div>
            <div className="text-[#ff6666]/80 text-[0.95rem] leading-snug">
              This repository is for experimental purposes only. Breaking changes, missing features, and rough edges are the norm.
            </div>
          </div>

          {/* CTA */}
          <div className="flex flex-wrap gap-x-4 gap-y-3 mb-12">
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
      <div className="fixed bottom-7 left-0 right-0 px-8 flex justify-between text-xs font-mono text-[#39ff14]/50 z-10">
        <div className="flex gap-5">
          <div>DAEMON: <span className="text-emerald-400">ONLINE</span></div>
          <div>
            MEMORIES:{" "}
            <span className="text-[#00fff5] transition-all duration-300">
              {memoryCount}
            </span>
          </div>
        </div>
        <div className="text-[#00fff5]">MODEL: Qwen3.6-35B-A3B</div>
      </div>
    </main>
  );
}
