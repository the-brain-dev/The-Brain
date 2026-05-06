# 🧠 the-brain — Pluggable Cognitive OS for AI Agents

**[the-brain.dev](https://the-brain.dev)**

> ⚠️ **Active Development** — This project is under heavy construction. APIs may change, features may be incomplete, and documentation may lag behind. Use at your own risk. Contributions and feedback welcome, but don't expect production stability yet.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-orange)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![Coverage](https://img.shields.io/badge/coverage-86%25-green)](https://github.com/the-brain-dev/Brain)

**the-brain** is an extensible, background orchestrator that observes your interactions with AI coding assistants and builds a persistent memory tailored specifically to **you**.

We don't force a single memory type. Instead, the-brain acts as a **central nervous system**, connecting various memory modules (Graph, Vector, LoRA) into one cohesive pipeline.

## Table of Contents

- [The Concept: A Modular 3-Layer Cognitive Architecture](#-the-concept-a-modular-3-layer-cognitive-architecture)
- [Quick Start](#-quick-start)
- [CLI Usage](#-cli-usage)
- [Project Structure](#-project-structure)
- [Tech Stack](#-tech-stack)
- [Packages](#-packages)
- [Building Your Own Plugin](#-building-your-own-plugin)
- [Documentation](#-documentation)
- [Contributing](#-contributing)
- [License](#-license)

## 💡 The Concept: A Modular 3-Layer Cognitive Architecture

Standard RAG is rigid and forgets context over time. the-brain implements an advanced, pluggable cognitive architecture inspired by human memory.

You can use our default built-in modules, swap them out for community plugins, or stack multiple memory types in the same layer. the-brain simply orchestrates the flow of data between them across three distinct time horizons:

| Layer | Purpose | Default Plugin | Alternative |
|-------|---------|---------------|-------------|
| ⚡ **Instant** | Immediate context injection | Graph Memory | Vector DB (RAG), KV Cache |
| ⚖️ **Selection** | Filter noise from signal | Surprise-Gated SPM | LLM-as-Judge, Heuristics |
| 🌌 **Deep** | Permanent consolidation | MLX LoRA Training | Modal Cloud, Dense Vector DB |

## 🚀 Quick Start

### Prerequisites

- **Bun** installed (`curl -fsSL https://bun.sh/install | bash`)
- (Optional) macOS Apple Silicon + `uv` for MLX LoRA training

### Installation

```bash
# One-liner install
curl -fsSL https://the-brain.dev/install.sh | bash

# Or install from source
git clone https://github.com/the-brain-dev/Brain.git
cd the-brain
bun install
bun run apps/cli/src/index.ts init
```

## 💻 CLI Usage

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

### Development

```bash
bun install          # Install all dependencies
bun test             # Run tests with coverage
bun run lint         # Lint and format check
bun run format       # Auto-fix formatting
./test.sh            # Run tests without API keys
bun run cli          # Run CLI from source
bun run daemon       # Run daemon from source
```

## 🧩 Project Structure

```
the-brain/
├── apps/
│   └── cli/                    # CLI application (cac-based, 6 commands)
│       └── src/
│           ├── index.ts        # Main entry point
│           ├── daemon.ts       # Background daemon runtime
│           └── commands/       # CLI subcommands
├── packages/
│   ├── core/                   # @the-brain/core — types, hooks, plugin manager, db
│   ├── plugin-graph-memory/    # ⚡ Instant Layer
│   ├── plugin-spm-curator/     # ⚖️ Selection Layer
│   ├── plugin-harvester-cursor/ # 📥 Cursor IDE harvester
│   ├── plugin-harvester-claude/ # 📥 Claude Code harvester
│   ├── plugin-identity-anchor/ # ⚓ Deep Layer — stable self-vector
│   ├── plugin-auto-wiki/       # 📚 Weekly static wiki output
│   ├── trainer-local-mlx/      # 💻 Local MLX LoRA training
│   └── python-sidecar/         # 🐍 Python MLX training script
├── docs/
│   ├── architecture.md         # Architecture & data flow
│   ├── plugins.md              # Plugin authoring guide
│   ├── configuration.md        # Full config reference
│   └── mlx-training.md         # MLX setup & training
├── scripts/
│   └── release.ts              # Release automation
├── AGENTS.md                   # Rules for AI agents
├── CONTRIBUTING.md             # Contribution guidelines
├── SECURITY.md                 # Security policy
├── README.md                   # This file
├── LICENSE                     # MIT
├── biome.json                  # Linter + formatter config
├── test.sh                     # Test runner (no API keys)
└── install.sh                  # One-liner installer
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
| **@the-brain/core** | Types, hooks, plugin manager, database layer |
| **@the-brain/plugin-graph-memory** | Instant memory layer with relation graphs |
| **@the-brain/plugin-spm-curator** | Surprise-gated prediction error filtering |
| **@the-brain/plugin-harvester-cursor** | Cursor IDE log reader |
| **@the-brain/plugin-harvester-claude** | Claude Code log reader |
| **@the-brain/plugin-identity-anchor** | Stable self-vector across retrains |
| **@the-brain/plugin-auto-wiki** | Weekly static wiki from learned knowledge |
| **@the-brain/trainer-local-mlx** | Local LoRA training on Apple Silicon |

## 🔌 Building Your Own Plugin

```typescript
import { definePlugin } from '@the-brain/core';

export default definePlugin({
  name: 'my-custom-memory',
  version: '1.0.0',
  setup(hooks) {
    hooks.hook('BEFORE_PROMPT', async (context) => {
      const extraKnowledge = await myVectorSearch(context.prompt);
      context.inject(extraKnowledge);
    });
  }
});
```

See [docs/plugins.md](docs/plugins.md) for the full plugin authoring guide.

## 📚 Documentation

- [Architecture & Data Flow](docs/architecture.md) — How the 3-layer system works
- [Writing Plugins](docs/plugins.md) — Build your own memory modules
- [Configuration](docs/configuration.md) — Full `config.yaml` reference
- [MLX Training](docs/mlx-training.md) — Local LoRA setup on Apple Silicon
- [AGENTS.md](AGENTS.md) — Rules for AI agents working on this project
- [CONTRIBUTING.md](CONTRIBUTING.md) — Contribution guidelines
- [SECURITY.md](SECURITY.md) — Security policy

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

**Before submitting a PR:**
```bash
bun test --coverage
bun run lint
```

## 📄 License

MIT License © 2026

---

> "The brain is a muscle that can be extended with code."
