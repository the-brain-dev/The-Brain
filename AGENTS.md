# Development Rules for the-brain

This document defines rules for both humans and AI agents working on this project.
Agents that comply with AGENTS.md (Cursor, Claude Code, Windsurf, pi, Copilot) will
automatically read and follow these rules when opened from the the-brain root directory.

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code (except README branding)
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")
- Communication with the user in Polish; all code, comments, docs, and changelogs in English

## Project Philosophy

- **Local-First**: Data never leaves the user's machine unless they explicitly install a cloud plugin.
  Defaults use local SQLite, local MLX training, and local models via Ollama/LM Studio.
- **Pluggable Architecture**: Core is an empty data bus. Everything — harvesters, memory modules,
  trainers — must be swappable plugins via `definePlugin()`.
- **Selection over Accumulation**: Dumping everything into memory causes noise and hallucinations.
  The system must actively reject redundant, low-value information (Surprise-Gated SPM).
- **Ambient UX**: The best tools are the ones you forget you're using. the-brain runs as a
  background daemon with zero-effort data collection.
- **TDD with >80% coverage**: All new code must include tests. Target >80% line coverage.

## Code Quality

- No `any` types unless absolutely necessary (document the reason with a comment)
- Always use top-level imports. No `await import("./foo.js")`, no `import("pkg").Type` in type positions
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- NEVER modify generated files directly. Update the generator script instead.
- All code, comments, and documentation in English. Only user-facing CLI messages may be localized.
- Use `bun test` as the test runner. Tests live in `src/__tests__/` next to the code they test.
- Before committing code changes (not doc changes): run `bun test` and `bun run lint`

## Commands

- After code changes: `bun test && bun run lint` (get full output, no tail). Fix all errors before committing.
- To run a specific test file: `bun test path/to/test.test.ts`
- To run coverage: `bun test --coverage`
- NEVER run `bun run dev` in the background without being asked
- NEVER commit unless the user asks

## Documentation

- **Docs live in `apps/docs/content/docs/`** — Fumadocs MDX files organized by section:
  - `start-here/` — Overview, Installation, Quickstart, Configuration
  - `core-concepts/` — Architecture, Hook System, Memory Layers
  - `customization/` — Plugins, Harvesters, MLX Training, Storage, Identity Anchor
  - `reference/` — CLI Reference, Config Schema, MCP Tools, Env Variables
  - `integrations/` — MCP Server, Remote Mode, IDE Setup, Menu Bar
  - `development/` — Contributing, Project Structure, Testing
- **Update docs IMMEDIATELY after code changes** — same commit if possible.
  - New CLI flag? → update `reference/cli-reference.mdx`
  - New config field? → update `start-here/configuration.mdx` and `reference/config-schema.mdx`
  - New hook/event? → update `core-concepts/hook-system.mdx`
  - New plugin/harvester? → update `customization/` section
  - New integration? → update `integrations/` section
- Build docs to verify: `cd apps/docs && bun run build` (should compile clean, 12+ pages)
- Dev server: `cd apps/docs && bun run dev` → http://localhost:3001
- CLI shortcut: `the-brain docs dev` / `the-brain docs build`

## Test Conventions

- Tests live in `src/__tests__/` alongside source files
- Use `process.env.HOME` override for test isolation (never mock.module())
- Integration tests use real filesystem paths but isolated under temp dirs
- Do not use real API keys or paid tokens in tests
- When fixing a bug, write a regression test first

## Changelog

Location: `packages/*/CHANGELOG.md` and `apps/*/CHANGELOG.md` (each package has its own)

### Format

Use these sections under `## [Unreleased]`:

- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

### Rules

- Before adding entries, read the full `[Unreleased]` section to see which subsections already exist
- New entries ALWAYS go under `## [Unreleased]` section
- Append to existing subsections (e.g., `### Fixed`), do not create duplicates
- NEVER modify already-released version sections
- Each version section is immutable once released

## Project Structure

```
the-brain/
├── apps/
│   └── cli/                    # CLI application (cac-based, 6 commands)
│       ├── src/
│       │   ├── index.ts        # Main entry point
│       │   ├── daemon.ts       # Background daemon runtime
│       │   └── commands/       # CLI subcommands
│       └── CHANGELOG.md
├── packages/
│   ├── core/                   # @the-brain/core — types, hooks, plugin manager, db
│   ├── plugin-graph-memory/    # ⚡ Instant Layer — graph-based quick corrections
│   ├── plugin-spm-curator/     # ⚖️ Selection Layer — surprise-gated filtering
│   ├── plugin-harvester-cursor/# 📥 Cursor IDE log harvester
│   ├── plugin-harvester-claude/ # 📥 Claude Code log harvester
│   ├── plugin-identity-anchor/ # ⚓ Deep Layer — stable self-vector
│   ├── plugin-auto-wiki/       # 📚 Weekly static wiki output
│   ├── trainer-local-mlx/      # 💻 Local MLX LoRA training
│   └── python-sidecar/         # 🐍 Python MLX training script
├── scripts/
│   └── release.ts              # Release automation
├── AGENTS.md                   # This file
├── CONTRIBUTING.md
├── README.md
├── LICENSE
├── biome.json
└── install.sh
```

## Adding a New Plugin

1. Create `packages/plugin-<name>/` with a `package.json`
2. Create `src/index.ts` exporting `default definePlugin({ name, setup })`
3. Write tests in `src/__tests__/`
4. Add to `apps/cli/src/daemon.ts` plugin registration
5. Add CHANGELOG.md
6. Update root README.md package table

## Adding a New Harvester

Adding a new harvester (IDE log parser) requires changes across multiple files.
Follow this checklist in order.

### 1. Harvester Plugin (`packages/plugin-harvester-<name>/`)

Create `src/index.ts`:

```typescript
import { definePlugin, type PluginHooks } from "@the-brain/core";

export default definePlugin({
  name: "harvester-<name>",
  version: "0.1.0",
  description: "Harvests interactions from <source> logs",
  async setup(hooks: PluginHooks) {
    hooks.hook("harvester:poll", async () => {
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
  source: string;        // "cursor", "windsurf", "claude", "copilot"
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
1. Read workspace root from IDE logs (Cursor: `workspace.json`, Windsurf: `projects.json`, Claude: `.claude/settings.json` first `cwd`)
2. Match `workDir` against registered project contexts in `config.json`
3. Tag interactions with matched project name
4. If no match: fall back to `"global"` context

### 5. Hook Registration

Your plugin MUST register on these hooks:
- `harvester:poll` — called by daemon at `pollIntervalMs` interval

Your plugin MUST emit:
- `harvester:newData` — `{ interactions: Interaction[], project: string }` when new interactions found

Optional hooks (recommended):
- `daemon:start` — initial state loading
- `daemon:stop` — flush state to disk

### 6. Tests (`packages/plugin-harvester-<name>/src/__tests__/`)

- **Unit tests**: At minimum:
  - `harvester-parse.test.ts` — test parsing of each log format variant
  - `harvester-dedup.test.ts` — verify deduplication across multiple polls
  - `harvester-state.test.ts` — verify state persistence and checkpoint resume
  - `harvester-project.test.ts` — verify workspace → project name matching
  - `harvester-edge.test.ts` — empty responses, UTF-8 issues, truncated files

- **Integration test**: Use `TestHarness` from `@the-brain/core`:
  ```typescript
  import { TestHarness } from "@the-brain/core";

  const harness = new TestHarness();
  await harness.start();

  // Register harvester plugin
  await harness.pluginManager.load(myHarvester);

  // Simulate log file creation
  writeFileSync(logPath, sampleLogContent);

  // Trigger poll
  await harness.hooks.callHook("harvester:poll");

  // Assert interactions were harvested
  const state = await harness.getState();
  expect(state.memoryCount).toBeGreaterThan(0);
  ```

- **Do NOT** use real API keys, real IDE processes, or production log paths in tests
- **Do NOT** connect to real SQLite databases outside test tmpdir
- Use `process.env.HOME` override for path isolation

### 7. Daemon Registration

Add to `apps/cli/src/daemon.ts` in the plugin list:
```typescript
import harvesterNew from "@the-brain/plugin-harvester-<name>";
// ...
const plugins = [harvesterCursor, harvesterClaude, harvesterNew, ...];
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

## Git Rules for Parallel Agents

Multiple agents may work on different files simultaneously. Follow these rules:

### Committing
- **ONLY commit files YOU changed in THIS session**
- NEVER use `git add -A` or `git add .` — sweeps up changes from other agents
- ALWAYS use `git add <specific-file-paths>` listing only files you modified
- Before committing, run `git status` and verify you are only staging YOUR files
- Track which files you created/modified/deleted during the session

### Forbidden Git Operations
These commands can destroy other agents' work:
- `git reset --hard` — destroys uncommitted changes
- `git checkout .` — destroys uncommitted changes
- `git clean -fd` — deletes untracked files
- `git stash` — stashes ALL changes including other agents' work
- `git add -A` / `git add .` — stages other agents' uncommitted work

### Safe Workflow
```bash
# 1. Check status first
git status
# 2. Add ONLY your specific files
git add packages/plugin-harvester-claude/src/index.ts
# 3. Commit
git commit -m "feat(claude): add Claude Code harvester plugin"
# 4. Push (pull --rebase if needed, but NEVER reset/checkout)
git pull --rebase && git push
```

### If Rebase Conflicts Occur
- Resolve conflicts in YOUR files only
- If conflict is in a file you didn't modify, abort and ask the user
- NEVER force push

## Releasing

**Lockstep versioning**: All packages always share the same version number.

**Version semantics**:
- `patch`: Bug fixes and new features
- `minor`: API breaking changes

### Steps
1. **Update CHANGELOGs**: Ensure all changes since last release are documented
2. **Run release script**: `bun run scripts/release.ts patch|minor|<x.y.z>`
3. The script handles: version bump, CHANGELOG finalization, commit, tag, publish, and new `[Unreleased]` sections

## User override

If the user instructions conflict with rules set out here, ask for confirmation that they want
to override the rules. Only then execute their instructions.
