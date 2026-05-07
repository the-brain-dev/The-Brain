     1|# 🧠 the-brain — Pluggable Cognitive OS for AI Agents
     2|
     3|**[the-brain.dev](https://the-brain.dev)**
     4|
     5|> ⚠️ **Active Development** — This project is under heavy construction. APIs may change, features may be incomplete, and documentation may lag behind. Use at your own risk. Contributions and feedback welcome, but don't expect production stability yet.
     6|
     7|[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
     8|[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-orange)](https://bun.sh)
     9|[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
    10|[![Coverage](https://img.shields.io/badge/coverage-86%25-green)](https://github.com/the-brain-dev/Brain)
    11|
    12|**the-brain** is an extensible, background orchestrator that observes your interactions with AI coding assistants and builds a persistent memory tailored specifically to **you**.
    13|
    14|We don't force a single memory type. Instead, the-brain acts as a **central nervous system**, connecting various memory modules (Graph, Vector, LoRA) into one cohesive pipeline.
    15|
    16|## Table of Contents
    17|
    18|- [The Concept: A Modular 3-Layer Cognitive Architecture](#-the-concept-a-modular-3-layer-cognitive-architecture)
    19|- [Quick Start](#-quick-start)
    20|- [CLI Usage](#-cli-usage)
    21|- [Project Structure](#-project-structure)
    22|- [Tech Stack](#-tech-stack)
    23|- [Packages](#-packages)
    24|- [Building Your Own Plugin](#-building-your-own-plugin)
    25|- [Documentation](#-documentation)
    26|- [Contributing](#-contributing)
    27|- [License](#-license)
    28|
    29|## 💡 The Concept: A Modular 3-Layer Cognitive Architecture
    30|
    31|Standard RAG is rigid and forgets context over time. the-brain implements an advanced, pluggable cognitive architecture inspired by human memory.
    32|
    33|You can use our default built-in modules, swap them out for community plugins, or stack multiple memory types in the same layer. the-brain simply orchestrates the flow of data between them across three distinct time horizons:
    34|
    35|| Layer | Purpose | Default Plugin | Alternative |
    36||-------|---------|---------------|-------------|
    37|| ⚡ **Instant** | Immediate context injection | Graph Memory | Vector DB (RAG), KV Cache |
    38|| ⚖️ **Selection** | Filter noise from signal | Surprise-Gated SPM | LLM-as-Judge, Heuristics |
    39|| 🌌 **Deep** | Permanent consolidation | MLX LoRA Training | Modal Cloud, Dense Vector DB |
    40|
    41|## 🚀 Quick Start
    42|
    43|### Prerequisites
    44|
    45|- **Bun** installed (`curl -fsSL https://bun.sh/install | bash`)
    46|- (Optional) macOS Apple Silicon + `uv` for MLX LoRA training
    47|
    48|### Installation
    49|
    50|```bash
    51|# One-liner install
    52|curl -fsSL https://the-brain.dev/install.sh | bash
    53|
    54|# Or install from source
    55|git clone https://github.com/the-brain-dev/Brain.git
    56|cd the-brain
    57|bun install
    58|bun run apps/cli/src/index.ts init
    59|```
    60|
    61|## 💻 CLI Usage
    62|
    63|```bash
    64|# Initialize database and config
    65|the-brain init
    66|
    67|# Start the background daemon
    68|the-brain daemon start
    69|
    70|# Check what your brain learned
    71|the-brain inspect --stats
    72|
    73|# Force a memory consolidation (Layer 2 → Layer 3)
    74|the-brain consolidate --now
    75|
    76|# List loaded plugins
    77|the-brain plugins list
    78|
    79|# Switch active context/project
    80|the-brain switch-context --project my-app
    81|```
    82|
    83|### Development
    84|
    85|```bash
    86|bun install          # Install all dependencies
    87|bun test             # Run tests with coverage
    88|bun run lint         # Lint and format check
    89|bun run format       # Auto-fix formatting
    90|./test.sh            # Run tests without API keys
    91|bun run cli          # Run CLI from source
    92|bun run daemon       # Run daemon from source
    93|```
    94|
    95|## 🧩 Project Structure
    96|
    97|```
    98|the-brain/
    99|├── apps/
   100|│   └── cli/                    # CLI application (cac-based, 6 commands)
   101|│       └── src/
   102|│           ├── index.ts        # Main entry point
   103|│           ├── daemon.ts       # Background daemon runtime
   104|│           └── commands/       # CLI subcommands
   105|├── packages/
   106|│   ├── core/                   # @the-brain/core — types, hooks, plugin manager, db
   107|│   ├── plugin-graph-memory/    # ⚡ Instant Layer
   108|│   ├── plugin-spm-curator/     # ⚖️ Selection Layer
   109|│   ├── plugin-harvester-cursor/ # 📥 Cursor IDE harvester
   110|│   ├── plugin-harvester-claude/ # 📥 Claude Code harvester
   111|│   ├── plugin-harvester-hermes/ # 📥 Hermes Agent harvester
   112|│   ├── plugin-identity-anchor/ # ⚓ Deep Layer — stable self-vector
   113|│   ├── plugin-auto-wiki/       # 📚 Weekly static wiki output
   114|│   ├── trainer-local-mlx/      # 💻 Local MLX LoRA training
   115|│   └── python-sidecar/         # 🐍 Python MLX training script
   116|├── docs/
   117|│   ├── architecture.md         # Architecture & data flow
   118|│   ├── plugins.md              # Plugin authoring guide
   119|│   ├── configuration.md        # Full config reference
   120|│   └── mlx-training.md         # MLX setup & training
   121|├── scripts/
   122|│   └── release.ts              # Release automation
   123|├── AGENTS.md                   # Rules for AI agents
   124|├── CONTRIBUTING.md             # Contribution guidelines
   125|├── SECURITY.md                 # Security policy
   126|├── README.md                   # This file
   127|├── LICENSE                     # MIT
   128|├── biome.json                  # Linter + formatter config
   129|├── test.sh                     # Test runner (no API keys)
   130|└── install.sh                  # One-liner installer
   131|```
   132|
   133|## 🛠 Tech Stack
   134|
   135|- **Core Orchestrator:** TypeScript, Bun, `cac`, `hookable`
   136|- **State Management:** Drizzle ORM + native `bun:sqlite`
   137|- **Optional ML Sidecar:** Python, `uv`, `mlx-lm` (Apple Silicon)
   138|- **Testing:** Bun test runner, >80% coverage target
   139|- **Linting/Formatting:** Biome
   140|
   141|## 📦 Packages
   142|
   143|| Package | Description |
   144||---------|-------------|
   145|| **@the-brain/core** | Types, hooks, plugin manager, database layer |
   146|| **@the-brain/plugin-graph-memory** | Instant memory layer with relation graphs |
   147|| **@the-brain/plugin-spm-curator** | Surprise-gated prediction error filtering |
   148|| **@the-brain/plugin-harvester-cursor** | Cursor IDE log reader |
   149|| **@the-brain/plugin-harvester-claude** | Claude Code log reader |
   150|| **@the-brain/plugin-harvester-hermes** | Hermes Agent log reader |
   151|| **@the-brain/plugin-identity-anchor** | Stable self-vector across retrains |
   152|| **@the-brain/plugin-auto-wiki** | Weekly static wiki from learned knowledge |
   153|| **@the-brain/trainer-local-mlx** | Local LoRA training on Apple Silicon |
   154|
   155|## 🔌 Building Your Own Plugin
   156|
   157|```typescript
   158|import { definePlugin } from '@the-brain/core';
   159|
   160|export default definePlugin({
   161|  name: 'my-custom-memory',
   162|  version: '1.0.0',
   163|  setup(hooks) {
   164|    hooks.hook('BEFORE_PROMPT', async (context) => {
   165|      const extraKnowledge = await myVectorSearch(context.prompt);
   166|      context.inject(extraKnowledge);
   167|    });
   168|  }
   169|});
   170|```
   171|
   172|See [docs/plugins.md](docs/plugins.md) for the full plugin authoring guide.
   173|
   174|## 📚 Documentation
   175|
   176|- [Architecture & Data Flow](docs/architecture.md) — How the 3-layer system works
   177|- [Writing Plugins](docs/plugins.md) — Build your own memory modules
   178|- [Configuration](docs/configuration.md) — Full `config.yaml` reference
   179|- [MLX Training](docs/mlx-training.md) — Local LoRA setup on Apple Silicon
   180|- [AGENTS.md](AGENTS.md) — Rules for AI agents working on this project
   181|- [CONTRIBUTING.md](CONTRIBUTING.md) — Contribution guidelines
   182|- [SECURITY.md](SECURITY.md) — Security policy
   183|
   184|## 🤝 Contributing
   185|
   186|See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).
   187|
   188|**Before submitting a PR:**
   189|```bash
   190|bun test --coverage
   191|bun run lint
   192|```
   193|
   194|## 📄 License
   195|
   196|MIT License © 2026
   197|
   198|---
   199|
   200|> "The brain is a muscle that can be extended with code."
   201|