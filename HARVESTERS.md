# Adding a New Harvester

Adding a new harvester (IDE log parser) requires changes across multiple files.
Follow this checklist in order.

### 1. Harvester Plugin (`packages/plugin-harvester-<name>/`)

Create `src/index.ts`:

```typescript
import { definePlugin, HookEvent, type PluginHooks } from "@the-brain-dev/core";

export default definePlugin({
  name: "harvester-<name>",
  version: "0.1.0",
  description: "Harvests interactions from <source> logs",
  async setup(hooks: PluginHooks) {
    hooks.hook(HookEvent.HARVESTER_POLL, async () => {
      // 1. Read source logs (files, SQLite, JSONL, LevelDB)
      // 2. Parse into Interaction[] format
      // 3. Track offset/checkpoint to avoid re-processing
      // 4. Deduplicate using SHA-256 of (prompt + response)
      // 5. Resolve project context via workDir matching
      // 6. Emit HARVESTER_NEW_DATA with interactions + project name
    });
  },
});
```

**Harvester State Format** — persist to `~/.the-brain/<harvester>-state.json`:
```json
{
  "lastOffset": 12345,
  "lastTimestamp": 1714800000000,
  "processedIds": ["abc123", "def456"],
  "projectContext": "e-commerce",
  "lastPoll": 1714800000000
}
```

**Required exports**:
- Default `definePlugin({ name, setup })`
- All hooks registered inside `setup()`, never outside

### 2. Interaction Parsing

Each harvester must produce `Interaction` objects matching:
```typescript
interface Interaction {
  id: string;            // SHA-256 hash of content
  timestamp: number;     // Unix milliseconds
  prompt: string;        // User's prompt to the AI
  response: string;      // AI's response (or empty for pending)
  context?: string;      // Additional context (file path, language, etc.)
  metadata?: Record<string, unknown>;
  source: string;        // "cursor", "claude", "gemini", "hermes", "lm-eval"
}
```

**Edge cases to handle**:
- Empty responses (in-progress conversations)
- Multi-message exchanges (group consecutive user/assistant pairs)
- Tool-use messages (strip tool output, keep thought process)
- UTF-8 encoding issues (sanitize with `.replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F]/g, "")`)

### 3. Deduplication Strategy

MUST implement content-based deduplication. Use SHA-256 of concatenated input:
```
hash = crypto.createHash("sha256")
  .update(prompt + "\x00" + response)
  .digest("hex")
```

- Check hash against `processedIds` in state file
- Check hash against existing memories in DB via `db.getMemory(id)`
- Never re-process the same interaction twice

### 4. Project Detection

Every harvester MUST resolve the project context:
1. Read workspace root from IDE logs (Cursor: `workspace.json`, Claude: `.claude/settings.json` first `cwd`, Gemini: `projects.json`)
2. Match `workDir` against registered project contexts in `config.json`
3. Tag interactions with matched project name
4. If no match: fall back to `"global"` context

### 5. Hook Registration

Your plugin MUST register on these hooks:
- `HookEvent.HARVESTER_POLL` — called by daemon at `pollIntervalMs` interval

Your plugin MUST emit:
- `HookEvent.HARVESTER_NEW_DATA` — `{ interactions: Interaction[], project: string }` when new interactions found

Optional hooks (recommended):
- `HookEvent.DAEMON_START` — initial state loading
- `HookEvent.DAEMON_STOP` — flush state to disk

### 6. Tests (`packages/plugin-harvester-<name>/src/__tests__/`)

- **Unit tests**: At minimum:
  - `harvester-parse.test.ts` — test parsing of each log format variant
  - `harvester-dedup.test.ts` — verify deduplication across multiple polls
  - `harvester-state.test.ts` — verify state persistence and checkpoint resume
  - `harvester-project.test.ts` — verify workspace → project name matching
  - `harvester-edge.test.ts` — empty responses, UTF-8 issues, truncated files

- **Integration test**: Use `TestHarness` from `@the-brain-dev/core`:
  ```typescript
  import { TestHarness } from "@the-brain-dev/core";

  const harness = new TestHarness();
  await harness.start();

  // Register harvester plugin
  await harness.pluginManager.load(myHarvester);

  // Simulate log file creation
  writeFileSync(logPath, sampleLogContent);

  // Trigger poll
  await harness.hooks.callHook(HookEvent.HARVESTER_POLL);

  // Assert interactions were harvested
  const state = await harness.getState();
  expect(state.memoryCount).toBeGreaterThan(0);
  ```

- **Do NOT** use real API keys, real IDE processes, or production log paths in tests
- **Do NOT** connect to real SQLite databases outside test tmpdir
- Use `process.env.HOME` override for path isolation

### 7. Daemon Registration

Add to `apps/cli/src/engine.ts` in **both** `loadPlugins()` return object **and** the plugin registration loop:

```typescript
// In loadPlugins():
const harvesterNew = await import("@the-brain-dev/plugin-harvester-<name>");
// Add to return { ..., harvesterNew, ... }

// In the plugin registration loop (init section, after loadPlugins()):
await pm.load(plugins.harvesterNew.default || plugins.harvesterNew);
```

### 8. Documentation

- `packages/plugin-harvester-<name>/README.md`:
  - Which IDE/assistant it supports
  - Where logs are found (macOS, Linux, Windows paths)
  - State file location and format
  - Known limitations (e.g., "Cursor LevelDB backend not yet supported")
- `packages/plugin-harvester-<name>/CHANGELOG.md`:
  - Add entry under `## [Unreleased]` → `### Added`
- Root `README.md`:
  - Add to "Built-in Extensions" table under "Data Harvesters"

### 9. Code Review Checklist

Before submitting, verify:
- [ ] Uses `definePlugin()` with clean `setup(hooks)` pattern
- [ ] Persists state to `~/.the-brain/<harvester>-state.json`
- [ ] Implements SHA-256 content deduplication
- [ ] Resolves project context via workDir matching
- [ ] Handles empty/partial/invalid log entries gracefully
- [ ] All new code has tests (target >80% coverage)
- [ ] No `any` types without documented reason
- [ ] Uses top-level imports only (no `await import()`)
- [ ] README.md documents log paths for all supported platforms
- [ ] CHANGELOG.md entry under `[Unreleased]` → `### Added`
