# Changelog — @the-brain-dev/core

## 0.2.0

### Minor Changes

- b0cb574: Interactive pipeline configurator — user chooses which plugins load at daemon start.

  - New `PipelineConfig` interface + Zod schema in core/types (`pipeline` field in config.json)
  - `PluginEntry` registry replaces hardcoded `import()` calls in engine.ts
  - `the-brain setup` CLI command — interactive TUI wizard + non-interactive flags
  - `install.sh` now runs interactive pipeline setup by default (`--quick` to skip)
  - Backward compatible: missing `pipeline` field → all plugins load as before
  - 39 new tests: pipeline schema validation, engine plugin enable/disable, setup command

## [Unreleased]

### Added

- **AuthDB** — Multi-user authentication database. Manages users, API tokens, and audit logs via Drizzle ORM + bun:sqlite. 13 methods: `createUser`, `getUser`, `getUserByName`, `getAllUsers`, `removeUser`, `createToken`, `revokeToken`, `validateToken`, `listUserTokens`, `updateUserPermissions`, `logAudit`, `getAuditLog`.
- **User types** — `User`, `UserRole` (ADMIN, CONTRIBUTOR, OBSERVER), `UserPermission`, `AuthToken`, `AuditEntry` with full Zod schemas.
- **PermissionResolver** — Role-based access control: `canRead`, `canWrite`, `canConsolidate`, `canTrain`, `canManageUsers`. Supports per-project role overrides.
- **`generateAuthToken`** — Cryptographic token generation (`mb_` prefix + 32 hex chars) via `crypto.getRandomValues()`.
- **`TheBrainConfig.serve.mode`** now supports `"team"` in addition to `"local"` and `"remote"`.
- **Team mode CLI** — `the-brain user add|list|remove|token|set-role` for managing team members and their API tokens.
- **Team mode API** — 7 new REST endpoints under `/api/users*` and `/api/audit-log` with admin-only Bearer auth.
- **`the-brain init --team`** — Creates `auth.db` with default admin user and configures `server.mode: "team"`.

### Changed

- `TheBrainConfigSchema` validates `server.mode` with `z.enum(["local", "remote", "team"])`.
- Auth token generation moved from inline to `generateAuthToken()` export.

## [0.1.0] — Initial release

### Added

- Core plugin system with `definePlugin()` and hook lifecycle
- BrainDB — Drizzle ORM + bun:sqlite with sessions, memories, graph_nodes tables
- 3-layer cognitive architecture: Instant (Graph Memory), Selection (SPM Curator), Deep (MLX LoRA)
- Multi-project isolation with global overlay
- Daemon HTTP API (:9420) with health, stats, consolidate, train, ingest endpoints
- CLI: `init`, `daemon`, `consolidate`, `inspect`, `train`, `plugins`, `context`, `wiki`, `health`, `dashboard`, `docs`, `mcp`, `agent`, `timeline`, `backend`, `switch-context`
- Pluggable backends: storage (SQLite/LibSQL), cleaner, scheduler, outputs
- Test harness with isolated test environments
