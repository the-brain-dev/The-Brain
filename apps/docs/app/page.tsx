import Link from "next/link";

export default function Home() {
  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-black text-white">
      <h1 className="text-6xl font-bold tracking-tight mb-4">
        🧠 the-brain
      </h1>
      <p className="text-xl text-zinc-400 mb-12 max-w-md text-center leading-relaxed">
        Local-first, pluggable cognitive OS
        for AI coding assistants.
      </p>
      <Link
        href="/docs"
        className="px-6 py-3 rounded-lg bg-white text-black font-medium hover:bg-zinc-200 transition-colors"
      >
        Read the docs
      </Link>
    </main>
  );
}
