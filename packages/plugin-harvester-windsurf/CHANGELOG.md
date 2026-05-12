# @the-brain-dev/plugin-harvester-windsurf

## 0.1.1

### Patch Changes

- Updated dependencies [b0cb574]
  - @the-brain-dev/core@0.2.0

## [Unreleased]

### Added

- Initial Windsurf Cascade trajectory harvester
- Reads conversatons from `state.vscdb` (`codeium.windsurf` → `cachedActiveTrajectory:*`)
- Protobuf wire-format decoder (base64 → wire-format → interaction pairs)
- Extracts thinking, visible responses, tool calls, provider info
- SHA-256 deduplication of (prompt, response) pairs
- Project detection via `workspaceStorage/<id>/workspace.json`
- State persistence to `~/.the-brain/windsurf-harvester-state.json`
- Integrates with daemon lifecycle (DAEMON_START, DAEMON_STOP, HARVESTER_POLL)
