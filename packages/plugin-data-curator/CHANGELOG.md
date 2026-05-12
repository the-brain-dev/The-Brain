# Changelog

## 0.1.1

### Patch Changes

- Updated dependencies [b0cb574]
  - @the-brain-dev/core@0.2.0

## [Unreleased]

### Added

- Initial release — quality-gated data curation pipeline
- Heuristics gate (regex-based) — catches context compaction, system noise, empty responses
- LLM Judge via local Ollama API — scores interactions 1-10 across 5 dimensions
- LLM Rewriter via local Ollama API — transforms poor interactions into clean training pairs
- Full Option D pipeline: Heuristics → Judge → Rewriter
- Configurable via environment: `THE_BRAIN_CURATOR_MODEL` (default: `gemma4:e4b`)
- Hook registration on `SELECTION_EVALUATE` (runs before SPM)
- Stats introspection via `getStats()` and `data-curator:getInstance` hook
