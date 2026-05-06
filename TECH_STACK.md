# 🏗 My-Brain: Tech Stack & Architecture

This document describes the technical stack for the the-brain project — a local, extensible background agent that analyzes IDE logs and trains personalized LoRA adapters.

## 🏗 Main Environment

- **Language:** TypeScript (main application logic) + Python (ML computation environment only)
- **Runtime:** Bun — Lightning-fast runtime with integrated SQLite and TypeScript support "out of the box"

## 🛠 Libraries & Tools (TypeScript)

| Tool | Purpose |
|------|---------|
| **cac** | Extremely lightweight CLI framework |
| **Drizzle ORM + bun:sqlite** | Super-fast, 100% type-safe local agent memory |
| **Zod** | Database protection against AI hallucinations (Structured Outputs) |
| **hookable** | Async, safe event lifecycle system (Hooks), foundation for plugin system |
| **croner** | Background daemon maintenance and overnight training scheduling |
| **consola** | Beautiful terminal interface (TUI) |

## 🐍 ML Environment (Sidecar)

- **uv** — Ultra-fast Python package manager (in Rust), used for isolation and installation of training dependencies
- **mlx-lm** — Apple's native library for efficient ML model training on Mac's Unified Memory

## ⚙️ Logic & Flow (Workflow)

```
┌──────────────────────────────────────────────────────────┐
│                   the-brain Pipeline                      │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  📥 HARVESTER LAYER                                      │
│  ┌──────────────────────────────────────────────┐       │
│  │  Cursor Harvester → Polls IDE logs            │       │
│  │  (Extensible: Windsurf, Copilot, etc.)        │       │
│  └──────────────┬───────────────────────────────┘       │
│                 │                                         │
│  ⚡ INSTANT LAYER (Working Memory)                       │
│  ┌──────────────────────────────────────────────┐       │
│  │  Graph Memory → Context injection before each │       │
│  │  prompt (corrections, preferences, patterns)  │       │
│  └──────────────┬───────────────────────────────┘       │
│                 │                                         │
│  ⚖️ SELECTION LAYER (Gatekeeper)                        │
│  ┌──────────────────────────────────────────────┐       │
│  │  SPM Curator → Prediction error calculation   │       │
│  │  Only "surprising" interactions pass through  │       │
│  └──────────────┬───────────────────────────────┘       │
│                 │                                         │
│  🌌 DEEP LAYER (Long-Term Consolidation)                │
│  ┌──────────────────────────────────────────────┐       │
│  │  ┌──────────┐  ┌──────────┐  ┌────────────┐ │       │
│  │  │ MLX LoRA │  │ Identity │  │ Auto-Wiki  │ │       │
│  │  │ Trainer  │  │ Anchor   │  │ Generator  │ │       │
│  │  └──────────┘  └──────────┘  └────────────┘ │       │
│  └──────────────────────────────────────────────┘       │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Data Collection (Harvester)
- **Polling** — Background application cyclically scans log files (e.g., from Cursor/Windsurf), preventing file blocking by the IDE

### Data Evaluation (Data Curation)
- **Hybrid Cascade Approach** — Cheap, synchronous rules (TS heuristics) during the day, and just before overnight training, selection by a lightweight, local "AI Judge" (Local LLM-as-a-Judge) or the built-in default *Surprise-Gated SPM*

### Distribution
- Binary file (`bun build --compile`) for easy execution + Shell installation script for Python environment preparation
