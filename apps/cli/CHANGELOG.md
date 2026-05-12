# Changelog

## 0.2.0

### Minor Changes

- b0cb574: Interactive pipeline configurator — user chooses which plugins load at daemon start.

  - New `PipelineConfig` interface + Zod schema in core/types (`pipeline` field in config.json)
  - `PluginEntry` registry replaces hardcoded `import()` calls in engine.ts
  - `the-brain setup` CLI command — interactive TUI wizard + non-interactive flags
  - `install.sh` now runs interactive pipeline setup by default (`--quick` to skip)
  - Backward compatible: missing `pipeline` field → all plugins load as before
  - 39 new tests: pipeline schema validation, engine plugin enable/disable, setup command

### Patch Changes

- Updated dependencies [b0cb574]
  - @the-brain-dev/core@0.2.0
  - @the-brain-dev/mcp-server@0.1.1
  - @the-brain-dev/plugin-auto-wiki@0.1.1
  - @the-brain-dev/plugin-graph-memory@0.1.1
  - @the-brain-dev/plugin-harvester-claude@0.1.1
  - @the-brain-dev/plugin-harvester-cursor@0.1.1
  - @the-brain-dev/plugin-identity-anchor@0.1.1
  - @the-brain-dev/plugin-spm-curator@0.1.1
  - @the-brain-dev/trainer-local-mlx@0.1.1

## 0.1.1

### Patch Changes

- 6ab5309: Rename CLI package from `the-brain` to `@the-brain-dev/cli` for npm org scope consistency. Binary name `the-brain` unchanged.

## [Unreleased]

### Added

- Extracted daemon engine into `engine.ts` with `initDaemon()` returning a testable `DaemonEngine` object (no infinite await).
- `getConfigDir()` and `getPidFile()` functions for dynamic path resolution based on `process.env.HOME`.
- Pipeline integration test: Interaction → Graph Memory → SPM Curator → MLX training data flow.
- Comprehensive inspect tests with seeded database covering search, top, sources, graph, recent, and memories flags.
- Engine tests for PID detection, stale PID cleanup, and `DaemonAlreadyRunningError`.

### Changed

- Daemon refactored: `startDaemon()` now calls `initDaemon()` from engine.ts, then runs the infinite processing loop.
- `stopDaemon()` uses `getPidFile()` instead of a module-level constant.

### Fixed

- Fixed pipeline disconnect between harvester events and Graph Memory -- daemon now fires `BEFORE_PROMPT` and `AFTER_RESPONSE` hooks for harvested interactions, enabling Graph Memory to create nodes.
- `context` command now uses `ContentCleaner` to strip XML noise from memories, producing compact summaries (50-80 chars vs 300+ raw XML).
- `context` command deduplicates memories across layers (instant/selection/deep), keeping highest-signal version.
- `consolidate --reprocess` handles duplicate `sel-` and `deep-` memory IDs gracefully (update instead of crash).
- SPM default threshold lowered from 0.42 to 0.30 based on production data calibration (was filtering 98.7% → now promotes ~32%).
- `wiki generate` no longer crashes on null surpriseScore (changed `!== undefined` to `!= null`).
- `context --markdown` no longer crashes on null surpriseScore (added `?? 0` fallback).
- `consolidate --reprocess` no longer floods terminal with stack traces on duplicate IDs (`console.error` → `consola.debug`).
- `daemon start` shows clean warning instead of stack trace when daemon already running (catches `DaemonAlreadyRunningError`).
- Missing required args (`daemon`, `backend`, `wiki`, etc.) show clean error instead of raw stack trace (try/catch around `cli.parse()`).
- `the-brain` (no args) and unknown commands show proper help/error in non-TTY terminals (added `command:*` handler + fallback).
- `setup --layer-instant`, `--mlx`, etc. validate values as `on|off` — garbage input rejected with error instead of silently writing corrupted config.
- `install.sh` and `apps/docs/public/install.sh` fix double-escaped `$PATH` (`\\\$PATH` → `\$PATH`) so PATH expands correctly when shell RC is sourced.
- `health`, `inspect`, `consolidate` now consistently reject `--project` + `--global` together.
- Emoji and box-drawing characters disabled in non-TTY terminals for clean piped output.

### Added

- Levenshtein distance suggestions for unknown commands: `the-brain inspetc` → "Did you mean inspect?"
- `api-server` and `wiki serve` handle EADDRINUSE by auto-releasing the port (`lsof` + `kill -9` + retry).
- `train --iterations` validates input as positive integer; rejects NaN, zero, and negative values.
- `setup` in non-TTY shows helpful fallback message instead of hanging on interactive wizard.

### Removed

- Dead `--layer` flag from `consolidate` (was accepted but never used).

### Added

- `the-brain context` command — exports brain state as JSON/markdown for external AI agents (Hermes).
- 5 integration tests for `context` command + 18 unit tests for `ContentCleaner`.
