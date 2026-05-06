# Changelog

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

### Added

- `the-brain context` command — exports brain state as JSON/markdown for external AI agents (Hermes).
- 5 integration tests for `context` command + 18 unit tests for `ContentCleaner`.

