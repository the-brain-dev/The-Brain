# @the-brain-dev/plugin-harvester-gemini

## 0.1.0 — Initial Release

- Polls `~/.gemini/tmp/<project>/logs.json` for user→gemini message pairs
- Discovers projects from `~/.gemini/projects.json` and hash-based session dirs
- Extracts text from content blocks (text, tool_use, thinking)
- Deduplicates by SHA256 hash of (sessionId, messageId)
- Saves poll state to `~/.the-brain/gemini-harvester-state.json`
- Integrates with daemon lifecycle (DAEMON_START, DAEMON_STOP, HARVESTER_POLL)
