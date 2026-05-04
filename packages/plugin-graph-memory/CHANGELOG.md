# Changelog

## [Unreleased]

### Fixed

- Fixed pipeline disconnect: Graph Memory `AFTER_RESPONSE` and `BEFORE_PROMPT` hooks were never fired by the daemon, resulting in 0 graph nodes from harvested interactions. Daemon now fires both hooks in the `HARVESTER_NEW_DATA` handler.
- Pattern node deduplication: each interaction no longer creates a duplicate pattern node. Existing matching patterns get their weight boosted by 0.1 instead.

### Added

- Initial release of my-brain -- pluggable cognitive OS for AI agents.

