# Architecture

the-brain implements a 3-layer cognitive architecture inspired by human memory.

## Data Flow

```
┌─────────────────────────────────────────────────────┐
│                    Data Harvesters                    │
│  (Cursor IDE, Claude Code, Windsurf, Terminal logs)  │
└─────────────────────┬───────────────────────────────┘
                      │ AFTER_FETCH hook
                      ▼
┌─────────────────────────────────────────────────────┐
│  ⚡ Layer 1: INSTANT (Working Memory)                 │
│  Plugin: plugin-graph-memory                         │
│  ─────────────────────────────────────────────────── │
│  • Intercepts prompts via BEFORE_PROMPT hook         │
│  • Stores immediate corrections in a local graph     │
│  • Injects context before next LLM call              │
│  • Feedback loop: correct once, remembered next time │
└─────────────────────┬───────────────────────────────┘
                      │ AFTER_RESPONSE hook
                      ▼
┌─────────────────────────────────────────────────────┐
│  ⚖️ Layer 2: SELECTION (The Gatekeeper)               │
│  Plugin: plugin-spm-curator                          │
│  ─────────────────────────────────────────────────── │
│  • Evaluates interactions for "surprise" value       │
│  • Z-score + cosine + n-gram prediction error        │
│  • Filters noise → promotes only valuable memories   │
│  • Selection over accumulation principle             │
└─────────────────────┬───────────────────────────────┘
                      │ ON_CONSOLIDATE hook
                      ▼
┌─────────────────────────────────────────────────────┐
│  🌌 Layer 3: DEEP (Long-Term / Optional)              │
│  Plugin: trainer-local-mlx                           │
│  ─────────────────────────────────────────────────── │
│  • Weekly LoRA training on curated data              │
│  • Runs while you sleep (cron scheduled)             │
│  • Updates local model weights                       │
│  • identity-anchor prevents catastrophic forgetting  │
│  • Optional: swap for cloud training or Vector DB    │
└─────────────────────────────────────────────────────┘
```

## Hook System

All plugins register on hooks defined in `@the-brain/core`:

| Hook | When | Used By |
|------|------|---------|
| `AFTER_FETCH` | New data harvested from IDE logs | Harvesters |
| `BEFORE_PROMPT` | Before prompt reaches LLM | Graph Memory (inject context) |
| `AFTER_RESPONSE` | After LLM responds | SPM Curator (evaluate) |
| `ON_CONSOLIDATE` | Triggered manually or by cron | MLX Trainer (LoRA) |
| `ON_STATS` | Stats/inspect query | Auto-Wiki, identity-anchor |

## Database Schema

Uses Drizzle ORM + `bun:sqlite`. Three core tables:

- `memories` — raw harvested interactions with metadata
- `graph_nodes` — relational memory nodes (Layer 1)
- `curated_items` — SPM-filtered high-value memories (Layer 2)

## Plugin Lifecycle

1. Plugin is defined via `definePlugin({ name, setup })`
2. `setup(hooks)` registers on hook events
3. PluginManager loads plugins from config
4. Hooks fire in registration order
5. Plugins can be hot-swapped without restart

## Extending

See [plugins.md](plugins.md) for writing your own plugin.
See [configuration.md](configuration.md) for advanced config.
See [mlx-training.md](mlx-training.md) for local training setup.
