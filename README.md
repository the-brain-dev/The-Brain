<p align="center">
  <img src="https://github.com/the-brain-dev/The-Brain/blob/main/apps/docs/public/logo.png?raw=true" alt="the-brain" width="128">
</p>

# the-brain — open memory platform for AI (Archived)

**[the-brain.dev](https://the-brain.dev)**

> **DEPRECATED — PROJECT ARCHIVED.** the-brain is no longer maintained. Do not install or use it for new projects. The source code and documentation are preserved for reference only.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-orange)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![Coverage](https://img.shields.io/badge/coverage-86%25-green)](https://github.com/the-brain-dev/Brain)

**the-brain** was an extension-first platform that observed your interactions with AI tools and built a persistent, private memory tailored to **you**.

It was designed as a **pluggable cognitive host**, connecting various memory modules (Graph, Vector, LoRA) into one cohesive pipeline — all replaceable, all local.

## Table of Contents

- [Quick Start (Archived)](#-quick-start-archived)
- [CLI Usage (Historical)](#-cli-usage-historical)
- [Tech Stack](#-tech-stack)
- [Packages](#-packages)
- [Plugin Architecture (Historical)](#-plugin-architecture-historical)
- [Documentation](#-documentation)
- [Contributing (Archived)](#-contributing-archived)
- [License](#-license)

## The Former Concept: A Modular 3-Layer Cognitive Architecture

the-brain implemented a pluggable 3-layer memory system:

```mermaid
flowchart LR
    H[Harvesters] --> Instant
    subgraph Instant["⚡ Instant Layer"]
        direction TB
        G[Graph Memory]
    end
    Instant --> Selection
    subgraph Selection["⚖️ Selection Layer"]
        direction TB
        S[SPM Curator]
    end
    Selection --> Deep
    subgraph Deep["🌌 Deep Layer"]
        direction TB
        W[LLM Wiki + LoRA]
    end
```

### ⚡ Instant Layer (Working Memory)

Injects context **before every prompt**.

**Examples:**
- Recent interactions from the current session
- Currently edited file and project context
- Recent corrections and user preferences
- Active graph nodes (Graph Memory)
- Daemon state and loaded plugins

### ⚖️ Selection Layer (Gatekeeper)

Evaluates interactions for surprise and decides what to promote to Deep.

**Examples:**
- Interactions with high `surprise_score`
- Explicit corrections and preferences
- Novel concepts and entities
- Patterns recurring across sessions
- Signals worth permanent storage (promote)

### 🌌 Deep Layer (Long-Term Memory)

Permanent consolidation of knowledge in human- and model-readable form.

**Examples:**
- **LLM Wiki** — automatically generated knowledge base (markdown + links)
- Trained LoRA adapters
- **Skill Forge** — automatic skill proposal and generation from graph patterns
- User identity vector / model fingerprint
- Long-term cross-project patterns

### Harvesters (Data Sources)

- `plugin-harvester-hermes`
- `plugin-harvester-cursor`
- `plugin-harvester-claude`
- `plugin-harvester-gemini`
- `plugin-harvester-lm-eval`
- `plugin-harvester-windsurf`

## 🚀 Quick Start (Archived)

### Historical Prerequisites

The former project used Bun and, optionally, macOS Apple Silicon with `uv` for MLX LoRA training.

### Installation (Archived)

The public installer has been removed. New installations are not supported. The source-level installer remains in the repository only as a historical artifact.

## 💻 CLI Usage (Historical)

The commands below document the former CLI surface and are not a supported operating procedure.

```bash
# Initialize database and config
the-brain init

# Start the background daemon
the-brain daemon start

# Check what your brain learned
the-brain inspect --stats

# Force a memory consolidation (Layer 2 → Layer 3)
the-brain consolidate --now

# List loaded plugins
the-brain plugins list

# Switch active context/project
the-brain switch-context --project my-app
```

### Historical Development

```bash
bun install          # Install all dependencies
bun test             # Run tests with coverage
bun run lint         # Lint and format check
bun run format       # Auto-fix formatting
./test.sh            # Run tests without API keys
bun run cli          # Run CLI from source
bun run daemon       # Run daemon from source
```

## 🛠 Tech Stack

- **Core Orchestrator:** TypeScript, Bun, `cac`, `hookable`
- **State Management:** Drizzle ORM + native `bun:sqlite`
- **Optional ML Sidecar:** Python, `uv`, `mlx-lm` (Apple Silicon)
- **Testing:** Bun test runner, >80% coverage target
- **Linting/Formatting:** Biome

## 📦 Packages

| Package | Description |
|---------|-------------|
| **@the-brain-dev/core** | Types, hooks, plugin manager, database layer |
| **@the-brain-dev/plugin-graph-memory** | Instant memory layer with relation graphs |
| **@the-brain-dev/plugin-spm-curator** | Surprise-gated prediction error filtering |
| **@the-brain-dev/plugin-harvester-cursor** | Cursor IDE log reader |
| **@the-brain-dev/plugin-harvester-claude** | Claude Code log reader |
| **@the-brain-dev/plugin-harvester-hermes** | Hermes Agent log reader |
| **@the-brain-dev/plugin-harvester-gemini** | Gemini CLI log reader |
| **@the-brain-dev/plugin-harvester-lm-eval** | Benchmark result harvester |
| **@the-brain-dev/plugin-harvester-windsurf** | Windsurf Cascade trajectory harvester |
| **@the-brain-dev/plugin-identity-anchor** | Stable self-vector across retrains |
| **@the-brain-dev/plugin-auto-wiki** | Weekly static wiki from learned knowledge |
| **@the-brain-dev/trainer-local-mlx** | Local LoRA training on Apple Silicon |

## 🔌 Plugin Architecture (Historical)

```typescript
import { definePlugin, HookEvent } from '@the-brain-dev/core';

export default definePlugin({
  name: 'my-custom-memory',
  version: '1.0.0',
  setup(hooks) {
    hooks.hook(HookEvent.BEFORE_PROMPT, async (context) => {
      const extraKnowledge = await myVectorSearch(context.prompt);
      context.inject(extraKnowledge);
    });
  },
});
```

See [Writing Plugins](https://the-brain.dev/docs/customization/writing-plugins) for the historical plugin authoring guide.

> **Extensions** are lightweight, single-file scripts that don't need a rebuild — but they're **disabled by default**. Enable them in `config.json`: `"extensions": ["name"]`.

## 📚 Documentation

Archived documentation is available at **[the-brain.dev](https://the-brain.dev)**.

- [the-brain.dev/docs](https://the-brain.dev/docs) — Archived documentation (architecture, plugins, configuration, MLX training)
- [AGENTS.md](AGENTS.md) — Rules for AI agents working on this project
- [CONTRIBUTING.md](CONTRIBUTING.md) — Contribution guidelines

## 🤝 Contributing (Archived)

The project is archived and no longer actively maintained. [CONTRIBUTING.md](CONTRIBUTING.md) is retained as a historical description of the former contribution process; new contributions and support are not expected.

**Historical verification commands:**
```bash
bun test --coverage     # >80% line coverage
bun run lint            # zero errors
cd apps/docs && bun run build  # docs compile clean
```

## 📄 License

MIT License © 2026

---

> "The brain is a muscle that can be extended with code."
