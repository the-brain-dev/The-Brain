# TheBrainBar — macOS Menu Bar App

Thin SwiftUI menu bar app for the-brain. Polls the daemon's HTTP API
(localhost:9420) and shows brain status in the macOS menu bar.

## Build

```bash
cd apps/menu-bar
swift build -c release
```

The binary will be at `.build/release/TheBrainBar`.

## Run

```bash
swift run
```

Or copy to Applications:

```bash
cp .build/release/TheBrainBar /Applications/
```

## How it works

- Polls `GET /api/health` every 5 seconds to check daemon status
- On click, polls `GET /api/stats` for full memory stats
- Green dot = daemon running, red dot = stopped
- Actions: Consolidate, Train, Open Wiki, Dashboard
- Native macOS notifications when training completes
