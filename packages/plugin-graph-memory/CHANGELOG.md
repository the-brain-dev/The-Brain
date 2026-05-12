# Changelog

## 0.1.1

### Patch Changes

- Updated dependencies [b0cb574]
  - @the-brain-dev/core@0.2.0

## [Unreleased]

### Fixed

- Fixed pipeline disconnect: Graph Memory `AFTER_RESPONSE` and `BEFORE_PROMPT` hooks were never fired by the daemon, resulting in 0 graph nodes from harvested interactions. Daemon now fires both hooks in the `HARVESTER_NEW_DATA` handler.
- Pattern node deduplication: each interaction no longer creates a duplicate pattern node. Existing matching patterns get their weight boosted by 0.1 instead.

### Added

- Initial release of the-brain -- pluggable cognitive OS for AI agents.
