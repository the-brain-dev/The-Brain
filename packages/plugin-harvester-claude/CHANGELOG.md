# Changelog

## [Unreleased]

### Fixed

- Fixed `isRealUserMessage()` missing `msg.type !== "user"` check -- assistant messages were being misidentified as user messages, preventing any interactions from being paired.
- Fixed daemon pipeline disconnect: `AFTER_RESPONSE` and `BEFORE_PROMPT` hooks were never fired for harvested interactions, preventing Graph Memory from creating nodes.

### Added

- Initial release of my-brain -- pluggable cognitive OS for AI agents.

