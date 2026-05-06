# Writing Your Own Plugin

the-brain's entire architecture is plugin-based. Everything — from data harvesters to
memory modules to trainers — is a plugin registered via `definePlugin()`.

## Quick Start

```typescript
import { definePlugin } from '@the-brain/core';

export default definePlugin({
  name: 'my-custom-plugin',
  version: '1.0.0',
  setup(hooks) {
    // Register on hooks
    hooks.hook('BEFORE_PROMPT', async (ctx) => {
      ctx.inject('System: remember this...');
    });

    hooks.hook('AFTER_RESPONSE', async (ctx) => {
      console.log('Response received:', ctx.response);
    });
  }
});
```

## Available Hooks

| Hook | Payload | Returns |
|------|---------|---------|
| `AFTER_FETCH` | `{ source, entries[], timestamp }` | `void` |
| `BEFORE_PROMPT` | `{ prompt, context, inject() }` | `void` |
| `AFTER_RESPONSE` | `{ prompt, response, model, timestamp }` | `void` |
| `ON_CONSOLIDATE` | `{ items[], force }` | `ConsolidateResult` |
| `ON_STATS` | `{}` | `Stats` |

## Plugin Types

### Data Harvester
Registers on `AFTER_FETCH`. Reads logs from IDE sources and feeds them into the
pipeline. Must implement:
- Incremental reading (track offsets to avoid re-reading)
- Deduplication (SHA-256 of content)
- State persistence (`~/.the-brain/<name>-state.json`)

### Memory Module (Instant Layer)
Registers on `BEFORE_PROMPT`. Injects context before the prompt reaches the LLM.
Examples: Graph Memory, Vector DB, KV Cache.

### Curator (Selection Layer)
Registers on `AFTER_RESPONSE`. Evaluates interactions and decides what to promote.
Examples: SPM, LLM-as-Judge, Heuristics.

### Trainer (Deep Layer)
Registers on `ON_CONSOLIDATE`. Consolidates curated data into permanent memory.
Examples: LoRA Training, Vector DB, Static Wiki.

## Package Structure

```
packages/plugin-<name>/
├── package.json          # { name: "@the-brain/plugin-<name>", main: "./src/index.ts" }
├── src/
│   ├── index.ts          # exports default definePlugin(...)
│   └── __tests__/
│       └── <name>.test.ts
├── CHANGELOG.md
└── README.md
```

## Testing Your Plugin

```bash
bun test packages/plugin-<name>
```

Use test isolation via `process.env.HOME`:
```typescript
import { afterEach, beforeEach, describe, test, expect } from 'bun:test';

describe('my plugin', () => {
  const originalHome = process.env.HOME;
  beforeEach(() => {
    process.env.HOME = '/tmp/test-home';
  });
  afterEach(() => {
    process.env.HOME = originalHome;
  });
});
```

## Registering with the Daemon

Add your plugin to `apps/cli/src/daemon.ts`:

```typescript
import myPlugin from '@the-brain/plugin-<name>';

pluginManager.register(myPlugin);
```

## Publishing

Plugins can be published as npm packages (`@the-brain/plugin-*`) or loaded from
local paths. See [configuration.md](configuration.md) for plugin loading options.
