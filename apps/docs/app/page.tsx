import Link from "next/link";

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white">
      {/* Research Status Banner */}
      <section className="w-full bg-amber-900/30 border-b border-amber-800/50">
        <div className="max-w-5xl mx-auto px-4 py-4 sm:py-5 text-center">
          <p className="text-sm text-amber-200/80">
            🧪 <span className="font-medium">Active research project.</span>{" "}
            <span className="text-amber-300/70">
              the-brain explores what happens when AI has persistent, private, 3-layer memory.
              Interested in the concept?{" "}
            </span>
            <a href="https://github.com/the-brain-dev/The-Brain" target="_blank" className="text-amber-300 underline hover:text-amber-200 transition-colors font-medium">
              Contribute
            </a>
            <span className="text-amber-300/70"> or </span>
            <Link href="/docs/customization/extensions" className="text-amber-300 underline hover:text-amber-200 transition-colors font-medium">
              build an extension
            </Link>
            <span className="text-amber-300/70">.</span>
          </p>
        </div>
      </section>

      {/* Hero Section */}
      <section className="flex flex-col items-center justify-center min-h-[60vh] px-4 pt-20 md:pt-4">
        <div className="relative">
          <div className="absolute -inset-1 bg-gradient-to-r from-cyan-500 via-violet-500 to-emerald-500 rounded-2xl blur-xl opacity-30" />
          <div className="relative px-8 py-6 rounded-2xl bg-black/90">
            <img src="/logo.png" alt="the-brain logo" className="w-20 h-20 mx-auto mb-3" />
            <h1 className="text-6xl font-bold tracking-tight text-center">
              the-brain
            </h1>
          </div>
        </div>

        <p className="text-xl text-zinc-400 mt-6 mb-3 max-w-2xl text-center leading-relaxed">
          An <span className="text-white font-medium">open memory platform for AI</span>{" "}
          — in the making. Local-first, 3-layer cognitive architecture, entirely pluggable.
        </p>

        <p className="text-sm text-zinc-500 mb-10 text-center max-w-xl">
          Swap any component. Bring your own harvester, memory strategy, or trainer.
          Works with any AI tool — coding assistants, chat, custom agents, MCP.
        </p>

        <div className="flex gap-4">
          <Link
            href="/docs"
            className="px-6 py-3 rounded-lg bg-white text-black font-medium hover:bg-zinc-200 transition-colors"
          >
            Read the docs →
          </Link>
          <Link
            href="/docs/customization/extensions"
            className="px-6 py-3 rounded-lg border border-zinc-700 text-zinc-300 font-medium hover:bg-zinc-900 transition-colors"
          >
            Build an extension →
          </Link>
          <a
            href="https://github.com/the-brain-dev/The-Brain"
            target="_blank"
            className="px-6 py-3 rounded-lg border border-zinc-700 text-zinc-300 font-medium hover:bg-zinc-900 transition-colors"
          >
            GitHub
          </a>
        </div>
      </section>

      {/* Architecture Section */}
      <section className="max-w-5xl mx-auto px-4 pb-24">
        <h2 className="text-2xl font-semibold text-center mb-3">3-layer cognitive architecture</h2>
        <p className="text-sm text-zinc-500 text-center mb-12">
          Every layer is a plugin slot. We ship defaults — swap anything with a community extension.
        </p>

        <div className="grid md:grid-cols-3 gap-6">
          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
            <div className="text-2xl mb-3">⚡</div>
            <h3 className="text-lg font-semibold mb-1">Instant Layer</h3>
            <p className="text-xs text-zinc-500 mb-3">What happens right now</p>
            <p className="text-sm text-zinc-400 leading-relaxed mb-4">
              Detects corrections, preferences, and patterns in real time.
              Language-agnostic structural heuristics with weight decay.
            </p>
            <div className="text-xs text-zinc-600 font-mono bg-zinc-800/50 rounded px-2 py-1 inline-block">
              Default: graph-memory
            </div>
            <span className="text-xs text-zinc-600 ml-2">— swap it</span>
          </div>

          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
            <div className="text-2xl mb-3">⚖️</div>
            <h3 className="text-lg font-semibold mb-1">Selection Layer</h3>
            <p className="text-xs text-zinc-500 mb-3">What's worth keeping</p>
            <p className="text-sm text-zinc-400 leading-relaxed mb-4">
              Surprise-Gated Prediction Error (SPM). Filters noise from signal.
              Composite score of scalar, embedding, and novelty metrics.
            </p>
            <div className="text-xs text-zinc-600 font-mono bg-zinc-800/50 rounded px-2 py-1 inline-block">
              Default: spm-curator
            </div>
            <span className="text-xs text-zinc-600 ml-2">— swap it</span>
          </div>

          <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-6">
            <div className="text-2xl mb-3">🌌</div>
            <h3 className="text-lg font-semibold mb-1">Deep Layer</h3>
            <p className="text-xs text-zinc-500 mb-3">Permanent consolidation</p>
            <p className="text-sm text-zinc-400 leading-relaxed mb-4">
              Two outputs: LoRA adapter training + Auto-Wiki knowledge graph.
              Adapter biases your model toward your style. Wiki builds searchable docs from memory.
            </p>
            <div className="text-xs text-zinc-600 font-mono bg-zinc-800/50 rounded px-2 py-1 inline-block">
              Default: mlx-lora + auto-wiki
            </div>
            <span className="text-xs text-zinc-600 ml-2">— bring your own</span>
          </div>
        </div>

        <div className="mt-8 bg-zinc-900/30 border border-zinc-800 rounded-xl p-5 text-center">
          <p className="text-sm text-zinc-400 font-mono mb-1">
            Your AI tool → ⚡ Instant → ⚖️ Selection → 🌌 Deep → Smarter conversations
          </p>
          <p className="text-xs text-zinc-600">
            Every arrow is a hook. Every box is a plugin. The core is just the data bus.
          </p>
        </div>
      </section>

      {/* Features Grid */}
      <section className="max-w-5xl mx-auto px-4 pb-24">
        <h2 className="text-2xl font-semibold text-center mb-12">Research Starter Pack</h2>
        <p className="text-sm text-zinc-500 text-center -mt-8 mb-10">
          What ships today. Everything else comes from the{" "}
          <Link href="/docs/packages" className="text-zinc-300 underline hover:text-white">extension ecosystem</Link>.
        </p>

        <div className="grid md:grid-cols-2 gap-4">
          <FeatureCard
            icon="🔌"
            title="Extension-First"
            desc="Core is an empty data bus. Everything — harvesters, memory modules, trainers — is a swappable plugin. Enable extensions in config.json and daemon loads them on start."
          />
          <FeatureCard
            icon="🏠"
            title="Local-First, Private"
            desc="Data never leaves your machine. Default SQLite + local MLX training. No cloud dependencies, no telemetry."
          />
          <FeatureCard
            icon="🧠"
            title="3-Layer Cognitive Memory"
            desc="Instant corrections, surprise-gated filtering, overnight consolidation. Inspired by human memory. Any layer is replaceable."
          />
          <FeatureCard
            icon="📥"
            title="Works with Any AI"
            desc="Harvesters for Cursor, Claude Code, Gemini, Hermes, and more. Build a harvester for any AI tool or chat in 20 lines."
          />
          <FeatureCard
            icon="📡"
            title="MCP Server + Remote"
            desc="26 MCP tools for Claude Desktop, Cursor, and Zed. Run the daemon on a Linux server, connect from anywhere."
          />
          <FeatureCard
            icon="🔧"
            title="Active Research"
            desc="Early stage. APIs may change. Concepts are solid. Come for the idea — contribute, fork, or build an extension."
          />
        </div>
      </section>

      {/* Quick Start */}
      <section className="max-w-3xl mx-auto px-4 pb-24">
        <h2 className="text-2xl font-semibold text-center mb-8">Quick Start</h2>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <pre className="text-sm text-zinc-300 font-mono leading-relaxed" style={{"whiteSpace": "normal"}}>
            <span className="text-zinc-600"># Install in 60 seconds</span>
            <br />
            <span className="text-cyan-400">curl -fsSL https://the-brain.dev/install.sh | bash</span>
            <br /><br />
            <span className="text-zinc-600"># Initialize</span>
            <br />
            <span className="text-emerald-400">the-brain init</span>
            <br /><br />
            <span className="text-zinc-600"># Start background daemon</span>
            <br />
            <span className="text-emerald-400">the-brain daemon start</span>
            <br /><br />
            <span className="text-zinc-600"># Your brain is now learning</span>
            <br />
            <span className="text-zinc-400">the-brain inspect --stats</span>
          </pre>
        </div>

        <div className="flex justify-center mt-8 gap-4">
          <Link
            href="/docs/start-here/installation"
            className="px-5 py-2.5 rounded-lg bg-zinc-800 text-zinc-300 font-medium hover:bg-zinc-700 transition-colors text-sm"
          >
            Installation guide
          </Link>
          <Link
            href="/docs/start-here/tutorial"
            className="px-5 py-2.5 rounded-lg bg-zinc-800 text-zinc-300 font-medium hover:bg-zinc-700 transition-colors text-sm"
          >
            End-to-end tutorial
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800 py-8 text-center text-sm text-zinc-600">
        <p>MIT © 2026 Oskar Schachta</p>
        <p className="mt-1">
          <a href="https://github.com/the-brain-dev/The-Brain" target="_blank" className="hover:text-zinc-400 transition-colors">GitHub</a>
          <span className="mx-2">·</span>
          <a href="https://hermes-agent.nousresearch.com" target="_blank" className="hover:text-zinc-400 transition-colors">Built with Hermes Agent</a>
        </p>
      </footer>
    </main>
  );
}

function FeatureCard({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-5">
      <div className="flex items-start gap-3">
        <span className="text-xl mt-0.5">{icon}</span>
        <div>
          <h3 className="font-semibold mb-1">{title}</h3>
          <p className="text-sm text-zinc-400 leading-relaxed">{desc}</p>
        </div>
      </div>
    </div>
  );
}
