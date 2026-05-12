---
"@the-brain-dev/core": minor
"@the-brain-dev/cli": minor
---

Interactive pipeline configurator — user chooses which plugins load at daemon start.

- New `PipelineConfig` interface + Zod schema in core/types (`pipeline` field in config.json)
- `PluginEntry` registry replaces hardcoded `import()` calls in engine.ts
- `the-brain setup` CLI command — interactive TUI wizard + non-interactive flags
- `install.sh` now runs interactive pipeline setup by default (`--quick` to skip)
- Backward compatible: missing `pipeline` field → all plugins load as before
- 39 new tests: pipeline schema validation, engine plugin enable/disable, setup command
