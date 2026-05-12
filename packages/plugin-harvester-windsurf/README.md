# plugin-harvester-windsurf

Data harvester for Windsurf IDE's Cascade conversation history.

## What it reads

- **Source**: `~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb` (macOS)
  - Linux: `~/.config/Windsurf/User/globalStorage/state.vscdb`
  - Windows: `%APPDATA%/Windsurf/User/globalStorage/state.vscdb`
  - Also checks `Windsurf - Next` variant first
- **Key**: `codeium.windsurf` → JSON → `windsurf.state.cachedActiveTrajectory:<workspace_id>`
- **Format**: Base64-encoded protobuf (wire-format)

## Extracted data

- User prompts and AI responses
- Thinking content (Cascade thinking mode)
- Tool calls with parameters
- Provider information (model used)
- Per-workspace isolation via `workspace.json`

## State file

`~/.the-brain/windsurf-harvester-state.json`

```json
{
  "lastPollTimestamp": 1714800000000,
  "processedIds": ["a1b2c3d4e5f6g7h8"],
  "trajectorySizes": {
    "workspace_hash": 12345
  }
}
```

## Limitations

- Only reads the **active** (most recently selected) trajectory per workspace
- To harvest a different conversation, first select it in Windsurf's Cascade sidebar
- Protobuf format may change with Windsurf updates — this plugin targets the current format as of Windsurf 2025+
- Requires Bun runtime (uses `bun:sqlite` for database access)
