# Changelog

## 0.1.1

### Patch Changes

- Updated dependencies [b0cb574]
  - @the-brain-dev/core@0.2.0

## [Unreleased]

### Fixed

- Fixed `isRealUserMessage()` missing `msg.type !== "user"` check -- assistant messages were being misidentified as user messages, preventing any interactions from being paired.
- Fixed daemon pipeline disconnect: `AFTER_RESPONSE` and `BEFORE_PROMPT` hooks were never fired for harvested interactions, preventing Graph Memory from creating nodes.

### Added

- Initial release of the-brain -- pluggable cognitive OS for AI agents.
