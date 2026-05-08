# Rebrand: Coding-Memory → AI Platform + Research Project

> **For Hermes:** Execute task-by-task. Each task is a self-contained file edit.
> Build docs after every 3 tasks. Commit after each task.

**Goal:** Shift all external messaging from "memory for coding assistants" to "open memory platform for AI — research project, 3-layer pluggable core, community extensions welcome."

**Architecture:** Pure content + metadata changes. No code changes. 14 files touched across landing page, docs MDX, sidebar meta.json, README, and metadata.

**Tech Stack:** Next.js page.tsx, Fumadocs MDX, JSON sidebar config, Markdown README.

---

### Task 1: Landing page — Hero + Status Banner

**Objective:** Replace the "cognitive OS for coding assistants" hero with the new platform + research messaging.

**Files:**
- Modify: `apps/docs/app/page.tsx:1-50` (Hero section + banner)

**Step 1: Write new Hero content**

Replace the hero section (lines 7-50) with:

```tsx
  {/* Research Status Banner */}
  <section className="w-full bg-amber-900/30 border-b border-amber-800/50">
    <div className="max-w-5xl mx-auto px-4 py-3 text-center">
      <p className="text-sm text-amber-200/80">
        🧪 <span className="font-medium">Active research project.</span>{" "}
        <span className="text-amber-300/70">
          the-brain explores what happens when AI has persistent, private, 3-layer memory.
          Interested in the concept?{" "}
        </span>
        <a href="https://github.com/the-brain-dev/Brain" target="_blank" className="text-amber-300 underline hover:text-amber-200 transition-colors font-medium">
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
  <section className="flex flex-col items-center justify-center min-h-[60vh] px-4">
    <div className="relative">
      <div className="absolute -inset-1 bg-gradient-to-r from-cyan-500 via-violet-500 to-emerald-500 rounded-2xl blur-xl opacity-30" />
      <div className="relative px-8 py-6 rounded-2xl bg-black/90 border border-zinc-800">
        <h1 className="text-6xl font-bold tracking-tight mb-3 text-center">
          🧠 the-brain
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
        href="https://github.com/the-brain-dev/Brain"
        target="_blank"
        className="px-6 py-3 rounded-lg border border-zinc-700 text-zinc-300 font-medium hover:bg-zinc-900 transition-colors"
      >
        GitHub
      </a>
    </div>

    <div className="flex gap-6 mt-6 text-sm text-zinc-600">
      <span>MIT License</span>
      <span>Bun + TypeScript</span>
      <span>Apple MLX</span>
      <span>86% Test Coverage</span>
    </div>
  </section>
```

**Step 2: Verify**

Run: `cd apps/docs && bun run dev` → open http://localhost:3001
Expected: Amber research banner at top, "open memory platform for AI" hero, three CTA buttons.

**Step 3: Commit**

```bash
git add apps/docs/app/page.tsx
git commit -m "docs: rebrand hero to open memory platform + research banner"
```

---

### Task 2: Landing page — 3-layer slots + Features rename

**Objective:** Rephrase the architecture section to present 3 layers as slots ("Default: X. Swap it.") and rename feature cards away from IDE-only language.

**Files:**
- Modify: `apps/docs/app/page.tsx:52-131` (Architecture + Features sections)

**Step 1: Replace Architecture section (lines 52-92)**

```tsx
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
              Overnight LoRA training on consolidated memories via Apple MLX.
              Fully private — data never leaves your machine.
            </p>
            <div className="text-xs text-zinc-600 font-mono bg-zinc-800/50 rounded px-2 py-1 inline-block">
              Default: mlx-lora
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
```

**Step 2: Replace Features section (lines 95-131)**

```tsx
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
            desc="Core is an empty data bus. Everything — harvesters, memory modules, trainers — is a swappable plugin. Drop a .ts file and it loads."
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
```

**Step 3: Verify**

Run: `cd apps/docs && bun run dev` → open http://localhost:3001
Expected: "every layer is a plugin slot" headline, "default: X — swap it" labels, features renamed.

**Step 4: Commit**

```bash
git add apps/docs/app/page.tsx
git commit -m "docs: reframe architecture as plugin slots, rename features"
```

---

### Task 3: Metadata — title + description

**Objective:** Update HTML metadata (title, og:description) to match new positioning.

**Files:**
- Modify: `apps/docs/app/layout.tsx:10-23`

**Step 1: Replace metadata block**

```typescript
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
```

**Step 2: Verify**

Run: `cd apps/docs && bun run build`
Expected: No errors. Check `curl -s https://localhost:3001 | grep -i '<title>'` shows new title.

**Step 3: Commit**

```bash
git add apps/docs/app/layout.tsx
git commit -m "docs: update metadata to open memory platform positioning"
```

---

### Task 4: Docs home page — index.mdx

**Objective:** Replace "Cognitive OS for coding assistants" with platform language + research note.

**Files:**
- Modify: `apps/docs/content/docs/index.mdx`

**Step 1: Edit frontmatter + intro**

Currently lines 1-15. Replace with:

```mdx
---
title: the-brain
description: An open memory platform for AI — 3-layer cognitive architecture, local-first, pluggable
---

# 🧠 the-brain

**An open memory platform for AI** — in the making. 3-layer cognitive architecture with an extension-first philosophy. Runs locally, costs nothing, and lets you swap any component.

> 🧪 **Active research project.** the-brain explores what persistent, private, 3-layer AI memory looks like. Interested in the concept? [Contribute on GitHub](https://github.com/the-brain-dev/Brain) or [build an extension](/docs/customization/extensions).
```

**Step 2: Replace "Why the-brain?" (line 12-14)**

```mdx
## Why the-brain?

AI forgets everything between sessions. the-brain remembers — across any AI tool you use. It harvests your conversations, filters noise from signal, and consolidates what matters. No cloud. No telemetry. Just a background daemon learning your patterns.
```

**Step 3: Replace "Architecture at a Glance" (line 41-51)**

```mdx
## Architecture at a Glance

Your AI tools feed into three plugin slots:

```
Any AI tool → ⚡ INSTANT slot — what happens now (default: graph-memory)
            → ⚖️ SELECTION slot — what's worth keeping (default: spm-curator)
            → 🌌 DEEP slot — permanent consolidation (default: mlx-lora)
```

Each slot is replaceable. Drop a `.ts` file into `~/.the-brain/extensions/` and it loads automatically.
```

**Step 4: Replace "What the-brain Learns" (line 53-58)**

```mdx
## What the-brain Learns

- **Corrections** — "No, actually use `useCallback` here" → remembers for next time
- **Preferences** — "I prefer arrow functions" → injected into every context
- **Patterns** — Repeated choices across sessions → auto-suggests related concepts
- **Identity** — Your stable preferences and style, maintained across retrains
```

**Step 5: Verify**

Run: `cd apps/docs && bun run dev` → open http://localhost:3001/docs
Expected: "open memory platform for AI" heading, research banner, plugin slot language.

**Step 6: Commit**

```bash
git add apps/docs/content/docs/index.mdx
git commit -m "docs: rebrand docs home to open platform + research note"
```

---

### Task 5: Docs start-here overview — index.mdx

**Objective:** Update overview page to remove "coding assistants" language.

**Files:**
- Modify: `apps/docs/content/docs/start-here/index.mdx`

**Step 1: Replace the opening**

Currently lines 1-20. Replace:

```mdx
---
title: Overview
description: the-brain — an open memory platform for AI with 3-layer cognitive architecture
---

the-brain is an extensible background daemon that observes your interactions with AI tools and builds a persistent memory tailored to **you**.

## Why the-brain?

AI forgets everything between sessions. the-brain remembers — your patterns, preferences, corrections, and evolving style. It runs locally, costs nothing, and requires zero effort.

## Quick Start

```bash
curl -fsSL https://the-brain.dev/install.sh | bash
the-brain init
the-brain daemon start
```

That's it. The daemon watches your AI tools and builds your brain in the background.
```

**Step 2: Replace "What the-brain Learns"**

Line 36-41 — add a fifth bullet:

```mdx
- **Corrections**: "No, actually use `useCallback` here" → remembers for next time
- **Preferences**: "I prefer arrow functions" → injected into every prompt
- **Patterns**: Repeated choices → auto-suggests related concepts
- **Projects**: Per-project memory isolation with cross-project promotion
- **Identity**: Your stable self-vector, maintained across retrains
```

**Step 3: Verify**

Run: `cd apps/docs && bun run dev` → open http://localhost:3001/docs/start-here
Expected: "observes your interactions with AI tools" (not "coding assistants"), identity bullet added.

**Step 4: Commit**

```bash
git add apps/docs/content/docs/start-here/index.mdx
git commit -m "docs: generalize start-here from coding assistants to any AI"
```

---

### Task 6: Packages → Extensions catalog

**Objective:** Rename "Package Catalog" → "Extension Catalog", add research status, community section placeholder.

**Files:**
- Modify: `apps/docs/content/docs/packages.mdx`

**Step 1: Replace frontmatter + intro (lines 1-9)**

```mdx
---
title: Extension Catalog
description: Browse the-brain extensions — harvesters, memory modules, trainers, and integrations
---

# Extension Catalog

Extensions for the-brain — swap any layer, harvest from any AI tool, train however you want. Mix and match.

> 🧪 The extensions below are our **research starter pack** — what ships today. Community extensions coming. [Build yours →](/docs/customization/extensions)
```

**Step 2: Replace "Built-in" status labels with "Starter pack" (lines 28, 40, 52, 58, 65, 75, 83, 92, 103, 112, 120, 128)**

Do a single `replace_all`:

Find: `**Status:** Built-in`
Replace: `**Status:** Starter pack`

Find: `**Status:** Built-in (macOS only)`
Replace: `**Status:** Starter pack (macOS only)`

Find: `**Status:** Built-in (optional)`
Replace: `**Status:** Starter pack (optional)`

**Step 3: Update "Harvesters" section description (line 69)**

```mdx
## 📥 Harvesters

Harvesters — collect interactions from any AI tool and push them into the pipeline.
```

**Step 4: Verify**

Run: `cd apps/docs && bun run dev` → open http://localhost:3001/docs/packages
Expected: "Extension Catalog" title, "research starter pack" banner, "Starter pack" labels.

**Step 5: Commit**

```bash
git add apps/docs/content/docs/packages.mdx
git commit -m "docs: rebrand packages to extensions catalog with starter pack labels"
```

---

### Task 7: Architecture page — core-concepts/index.mdx

**Objective:** Add "extension-first" language to architecture, remove IDE-specific harvester names.

**Files:**
- Modify: `apps/docs/content/docs/core-concepts/index.mdx`

**Step 1: Update Design Principles (line 59-67)**

Replace the design principles block:

```mdx
## Design Principles

**Extension-First:** Core is an empty data bus. Everything — harvesters, memory modules, trainers — is a swappable plugin via `definePlugin()`. Drop a `.ts` file into `~/.the-brain/extensions/` — no rebuild, no restart.

**Local-First:** Data never leaves your machine unless you explicitly install a remote storage plugin. Defaults use local SQLite, local MLX training.

**Selection over Accumulation:** The system actively rejects redundant information. SPM (Surprise-Gated Prediction Error) learns only from what surprises you.

**Ambient UX:** Zero-effort background daemon. No manual input required.

**Research-First:** Early stage. Concepts are solid, APIs may change. The platform is the playground — contribute or build your own layer plugin.
```

**Step 2: Update Database description (line 73)**

Replace:

```mdx
- `sessions` — session tracking across IDE instances
```

With:

```mdx
- `sessions` — session tracking across your AI tools
```

**Step 3: Verify**

Run: `cd apps/docs && bun run dev` → open http://localhost:3001/docs/core-concepts
Expected: "Extension-First" as first principle, "Research-First" added.

**Step 4: Commit**

```bash
git add apps/docs/content/docs/core-concepts/index.mdx
git commit -m "docs: add extension-first + research-first to design principles"
```

---

### Task 8: Sidebar restructuring

**Objective:** Move Extensions from a customization sub-page to a top-level section item so it's more prominent.

**Files:**
- Modify: `apps/docs/content/docs/meta.json`
- Modify: `apps/docs/content/docs/customization/meta.json`

**Step 1: Read current sidebar structure**

Current `meta.json` (root): `"pages": ["start-here", "packages", "core-concepts", "customization", "reference", "integrations", "development", "troubleshooting", "acknowledgements"]`

No changes to root needed — Extensions stays under Customization in the sidebar for now, but we'll make it more prominent by updating the Customization section meta.

**Step 2: Update customization/meta.json**

Currently extensions is just one page among customization sub-pages. Make it the first item:

```json
{
  "title": "Customization",
  "pages": ["extensions", "writing-plugins", "plugin-contracts", "harvesters", "mlx-training", "storage-backends", "identity-anchor", "python-sidecar", "prompt-system"]
}
```

**Step 3: Verify**

Run: `cd apps/docs && bun run dev` → open http://localhost:3001/docs/customization
Expected: Extensions listed first in the sidebar.

**Step 4: Commit**

```bash
git add apps/docs/content/docs/customization/meta.json
git commit -m "docs: promote extensions to first in customization sidebar"
```

---

### Task 9: Extensions page — add platform framing

**Objective:** Add a note at the top of the extensions page that extensions ARE the-brain.

**Files:**
- Modify: `apps/docs/content/docs/customization/extensions.mdx`

**Step 1: Prepend platform note after frontmatter**

Insert after line 4 (before "## Quick Start"):

```mdx
> 💡 **Extensions are the product.** the-brain's core is a thin event bus + plugin manager. Everything that makes it useful — harvesters, memory strategies, trainers, notifications — is an extension. The built-in starter pack are extensions too. Build yours and grow the ecosystem.
```

**Step 2: Verify**

Run: `cd apps/docs && bun run dev` → open http://localhost:3001/docs/customization/extensions
Expected: Platform note at top.

**Step 3: Commit**

```bash
git add apps/docs/content/docs/customization/extensions.mdx
git commit -m "docs: add platform framing to extensions page"
```

---

### Task 10: README.md — landing page of the repo

**Objective:** Update root README to match new positioning + research status.

**Files:**
- Modify: `README.md`

**Step 1: Replace title + intro (lines 1-14)**

```markdown
# 🧠 the-brain — open memory platform for AI

**[the-brain.dev](https://the-brain.dev)**

> 🧪 **Active research project.** the-brain explores what happens when AI has persistent, private, 3-layer memory. It works today for coding assistants. We're building the platform for everything else. Interested? [Contribute](CONTRIBUTING.md) or [build an extension](https://the-brain.dev/docs/customization/extensions).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-orange)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![Coverage](https://img.shields.io/badge/coverage-86%25-green)](https://github.com/the-brain-dev/Brain)

**the-brain** is an extension-first platform that observes your interactions with AI tools and builds a persistent, private memory tailored to **you**.

We don't force a single memory type. Instead, the-brain acts as a **pluggable cognitive host**, connecting various memory modules (Graph, Vector, LoRA) into one cohesive pipeline — all replaceable, all local.
```

**Step 2: Verify**

Run: `head -20 README.md` — check new content.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rebrand README to open platform + research project"
```

---

### Task 11: Docs build + link check

**Objective:** Build the docs, verify zero errors, run link checker.

**Files:** None (verification only)

**Step 1: Build**

```bash
cd apps/docs && bun run build
```

Expected: exit code 0, no errors. ~15 pages compile.

**Step 2: Link check**

```bash
cd apps/docs && rg -n 'coding assistant|cognitive operating system|cognitive OS' content/docs/ app/page.tsx app/layout.tsx
```

Expected: 0 matches (only possibly in code examples or historical references).

Also check for stale URLs:

```bash
rg -n 'oskarschachta/the-brain' apps/docs/ README.md
```

Expected: 0 matches (all already migrated to `the-brain-dev/Brain`).

**Step 3: Commit (if any fixes needed)**

```bash
# Only if issues were found and fixed
git add .
git commit -m "docs: fix stale references found in build/link check"
```

---

### Task 12: Final review — consistency check

**Objective:** Read every changed file to confirm consistent messaging.

**Files:**
- Re-read: `apps/docs/app/page.tsx`
- Re-read: `apps/docs/app/layout.tsx`
- Re-read: `apps/docs/content/docs/index.mdx`
- Re-read: `apps/docs/content/docs/start-here/index.mdx`
- Re-read: `README.md`

**Step 1: Verify consistent language**

Open all in dev server:

```bash
cd apps/docs && bun run dev
```

Check these pages for consistent messaging:
1. **Landing page** (/) — "open memory platform", research banner, "swap it", "extension-first"
2. **Docs home** (/docs) — same language, research note visible
3. **Extension catalog** (/docs/packages) — "starter pack", "build yours"
4. **Architecture** (/docs/core-concepts) — "extension-first" as first principle
5. **Extensions** (/docs/customization/extensions) — platform note at top

**Step 2: Spot-check for "coding assistant" leaks**

```bash
rg -n 'coding assistant' apps/docs/content/docs/ apps/docs/app/
```

Expected: Only in old code examples or historical content. Any remaining occurrences should be intentional.

**Step 3: Final commit**

```bash
git add .
git commit -m "docs: final consistency check for platform rebrand"
```

---

## Summary

| # | Task | File(s) | What Changes |
|---|------|---------|-------------|
| 1 | Hero + banner | `page.tsx` | "Cognitive OS for coding" → "open memory platform" + research banner |
| 2 | Slots + Features | `page.tsx` | Layers become slots, features renamed |
| 3 | Metadata | `layout.tsx` | Title, description, og tags updated |
| 4 | Docs home | `index.mdx` | Frontmatter, intro, architecture, what-it-learns |
| 5 | Overview | `start-here/index.mdx` | "coding assistants" → "AI tools", identity bullet |
| 6 | Package catalog | `packages.mdx` | "Packages" → "Extensions", "Built-in" → "Starter pack" |
| 7 | Architecture | `core-concepts/index.mdx` | Extension-first principle, research-first, IDE→tools |
| 8 | Sidebar order | `customization/meta.json` | Extensions first |
| 9 | Extensions page | `extensions.mdx` | Platform framing note at top |
| 10 | README | `README.md` | Title, intro, research banner |
| 11 | Build + link check | — | Verify zero errors, no stale references |
| 12 | Final review | All above | Consistency check, leak scan |

**Total:** 12 tasks, 11 commits, ~10 files modified. No code changes — pure messaging.
