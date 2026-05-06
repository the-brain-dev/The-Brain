# Changelog

## [Unreleased]

### Added

- Initial release of the-brain — pluggable cognitive OS for AI agents.

## [2.0.0] - 2026-05-04

### Added

- **Karpathy-style wiki architecture**: `raw/`, `entities/` (patterns/corrections/preferences/concepts), `weekly/`, `meta/`, `SCHEMA.md`, `index.md`, `log.md`
- **Raw memory dump**: Immutable snapshot of all memories on each generation (`raw/memory-dump-{date}.md`)
- **Entity pages**: Auto-created from high-weight graph nodes (≥0.3) with YAML frontmatter, confidence scoring (high/medium/low), `[[wikilinks]]` to connected entities
- **Weekly summaries**: Stats + surprising interactions + entity overview per ISO week
- **Content index** (`index.md`): Sectioned catalog with confidence emoji markers
- **Registry** (`meta/registry.json`): JSON map of all pages with type, confidence, tags, connections
- **Backlinks** (`meta/backlinks.json`): Link graph for navigation
- **Lint** (`meta/lint-report.md`): Broken wikilinks, missing frontmatter fields, orphan pages
- **Append-only log** (`log.md`): Chronological record of all generation events
- **Schema bootstrap** (`SCHEMA.md`): Auto-generated conventions on first run, never overwritten

### Changed

- Vastly improved from single flat file → proper interlinked wiki with 4-layer architecture
- Entity confidence derived from graph node weight (≥0.7=high, ≥0.4=medium, <0.4=low)
- All generated files include proper YAML frontmatter with required fields

### Technical

- 17 new tests, 268 total pass (0 fail)
- Wiki path: `~/.the-brain/wiki/` (configurable via `outputDir`)
- Idempotent — re-generation updates existing pages, appends to log, re-lints
