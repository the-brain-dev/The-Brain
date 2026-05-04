# Changelog

## [Unreleased]

### Added

- Initial release of my-brain -- pluggable cognitive OS for AI agents.
- `ContentCleaner` module: extracts signal from raw XML-wrapped Claude Code memories. Detects user requests, observations, progress checkpoints. Deduplicates across layers.
- `cleanMemoryContent()`, `cleanGraphNodeLabel()`, `deduplicateContents()` exported from `@my-brain/core`.

