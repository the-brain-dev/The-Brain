"use client";

import { useState, useEffect } from "react";

const PASSWORD_HASH = "867afee2651c45f0e8bf8b5e68abea3ea7dcb4acbc6bf2c1dcb469bb279081ca";

async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default function PasswordGate({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    setAuthed(localStorage.getItem("the-brain-auth") === "1");
  }, []);

  if (authed === null) return null;
  if (authed) return <>{children}</>;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const hash = await sha256(input);
    if (hash === PASSWORD_HASH) {
      localStorage.setItem("the-brain-auth", "1");
      setAuthed(true);
    } else {
      setError(true);
      setInput("");
    }
  }

  return (
    <main className="min-h-screen bg-black flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-white text-center mb-2">🧠 the-brain</h1>
        <p className="text-sm text-zinc-500 text-center mb-8">
          Research preview — protected
        </p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="password"
            value={input}
            onChange={(e) => { setInput(e.target.value); setError(false); }}
            placeholder="Enter password"
            className="px-4 py-3 rounded-lg bg-zinc-900 border border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-zinc-500 text-sm"
            autoFocus
          />
          {error && (
            <p className="text-red-400 text-xs text-center">Wrong password</p>
          )}
          <button
            type="submit"
            className="px-4 py-3 rounded-lg bg-white text-black font-medium hover:bg-zinc-200 transition-colors text-sm"
          >
            Enter
          </button>
        </form>
      </div>
    </main>
  );
}
