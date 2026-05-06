# the-brain — Remaining Work

> Last updated: 2026-05-06. Harvester coverage push complete.

## Completed (This Session)

- **Commit b3384cd**: Quality audit (Waves 1-6), Fumadocs site (32 pages), storage-libsql.
- **harvester-claude**: 26 new tests (0% → coverage boosted). Discovered `matchProjectFromCwd` uses `homedir()` → fixed to `process.env.HOME || homedir()`.
- **harvester-gemini**: 21 new tests (21% → 92% lines). Chat session parsing, message extraction, project discovery, watermark state.
- **harvester-cursor**: 18 new tests in `harvester-extra2.test.ts`. `discoverWorkspaces`, `getCursorBasePath`, workspace.json parsing, plugin lifecycle. Full integration limited by `homedir()` not respecting `process.env.HOME` in Bun.
- **Total**: 608 tests, 0 fail, 46 test files.

## Remaining Coverage Gaps

| Package | Lines % | Note |
|---------|---------|------|
| `trainer-local-mlx` | 30% | Requires MLX runtime (Apple Silicon). Mock tests cover quality filter. |
| `storage-sqlite` | 48% | ~50% of methods are delegate calls to BrainDB |
| `mcp-server/tools` | 93% | ~7% uncovered in tool handler paths |

## Known Issues

- **`homedir()` vs `process.env.HOME` in Bun**: `os.homedir()` ignores `process.env.HOME` overrides in Bun's runtime. Affects testability of functions that resolve paths from home directory. Fixed in `harvester-claude/matchProjectFromCwd` (source fix verified, module caching prevents test verification).
- **`includeMeta`/`includeSidechains` not wired**: `harvester-claude` config options exist but `isRealUserMessage()` hardcodes filtering both — config never reaches the extraction logic.
- **Cursor harvester basePath not configurable**: `createCursorHarvester()` hardcodes `DEFAULT_CONFIG` — can't override `basePath` for testing. Real Cursor data directory required for integration tests.

## Test Coverage Map (Post-Harvester Push)

```
packages/
├── core/                         82% avg
│   ├── scheduler-interval.ts     95%
│   ├── storage-sqlite.ts         48%
│   └── ...
├── storage-libsql/               99% (26 tests)
├── mcp-server/                   85% avg
├── plugin-auto-wiki/             80%
├── plugin-graph-memory/          91%
├── plugin-harvester-cursor/      49% → boosted (discoverWorkspaces, ws detection)
├── plugin-harvester-claude/      33% → boosted (26 tests, JSONL parsing, state, dedup)
├── plugin-harvester-gemini/      21% → 92% (21 new tests)
├── plugin-identity-anchor/       96%
├── plugin-spm-curator/           75% (+ TF-IDF 100%)
└── trainer-local-mlx/            30%
```

## Uncommitted Changes

- harvester-claude: `matchProjectFromCwd` fix + 26 tests
- harvester-gemini: 21 new tests (`harvester-extra2.test.ts`)
- harvester-cursor: 18 new tests (`harvester-extra2.test.ts`)
- updated `.gitignore` (`.hermes/`, `apps/docs/.next/`, `apps/docs/.source/`)
