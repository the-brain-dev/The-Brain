# Development Rules for the-brain

This document defines rules for both humans and AI agents working on this project.
Agents that comply with AGENTS.md (Cursor, Claude Code, Gemini CLI, Hermes Agent) will
automatically read and follow these rules when opened from the the-brain root directory.

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code (except README branding)
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")
- Communication with the user in Polish; all code, comments, docs, and changelogs in English

## Project Philosophy

- **Local-First**: Data never leaves the user's machine unless they explicitly install a cloud plugin.
  Defaults use local SQLite, local MLX training, and local models via Ollama/LM Studio.
- **Pluggable Architecture**: Core is an empty data bus. Everything — harvesters, memory modules,
  trainers — must be swappable plugins via `definePlugin()`.
- **Selection over Accumulation**: Dumping everything into memory causes noise and hallucinations.
  The system must actively reject redundant, low-value information (Surprise-Gated SPM).
- **Ambient UX**: The best tools are the ones you forget you're using. the-brain runs as a
  background daemon with zero-effort data collection.
- **TDD with >80% coverage**: All new code must include tests. Target >80% line coverage.

## Code Quality

- No `any` types unless absolutely necessary (document the reason with a comment)
- Always use top-level imports. No `await import("./foo.js")`, no `import("pkg").Type` in type positions
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before removing functionality or code that appears to be intentional
- NEVER modify generated files directly. Update the generator script instead.
- All code, comments, and documentation in English. Only user-facing CLI messages may be localized.
- Use `bun test` as the test runner. Tests live in `src/__tests__/` next to the code they test.
- Before committing code changes (not doc changes): run `bun test` and `bun run lint`

## Commands

- After code changes: `bun test && bun run lint` (get full output, no tail). Fix all errors before committing.
- To run a specific test file: `bun test path/to/test.test.ts`
- To run coverage: `bun test --coverage`
- NEVER run `bun run dev` in the background without being asked
- NEVER commit unless the user asks

## Documentation

- **Docs live in `apps/docs/content/docs/`** — Fumadocs MDX files organized by section:
  - `start-here/` — Overview, Installation, Quickstart, Configuration
  - `core-concepts/` — Architecture, Hook System, Memory Layers
  - `customization/` — Plugins, Harvesters, MLX Training, Storage, Identity Anchor
  - `reference/` — CLI Reference, Config Schema, MCP Tools, Env Variables
  - `integrations/` — MCP Server, Remote Mode, IDE Setup, Menu Bar
  - `development/` — Contributing, Project Structure, Testing
- **Update docs IMMEDIATELY after code changes** — same commit if possible.
  - New CLI flag? → update `reference/cli-reference.mdx`
  - New config field? → update `start-here/configuration.mdx` and `reference/config-schema.mdx`
  - New hook/event? → update `core-concepts/hook-system.mdx`
  - New plugin/harvester? → update `customization/` section
  - New integration? → update `integrations/` section
- Build docs to verify: `cd apps/docs && bun run build` (should compile clean, 12+ pages)
- Dev server: `cd apps/docs && bun run dev` → http://localhost:3001
- CLI shortcut: `the-brain docs dev` / `the-brain docs build`

## Test Conventions

- Tests live in `src/__tests__/` alongside source files
- Use `process.env.HOME` override for test isolation (never mock.module())
- Integration tests use real filesystem paths but isolated under temp dirs
- Do not use real API keys or paid tokens in tests
- When fixing a bug, write a regression test first

## Changelog

Location: `packages/*/CHANGELOG.md` and `apps/*/CHANGELOG.md` (each package has its own)

### Format

Use these sections under `## [Unreleased]`:

- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

### Rules

- Before adding entries, read the full `[Unreleased]` section to see which subsections already exist
- New entries ALWAYS go under `## [Unreleased]` section
- Append to existing subsections (e.g., `### Fixed`), do not create duplicates
- NEVER modify already-released version sections
- Each version section is immutable once released

## Project Structure

```
the-brain/
├── apps/
│   └── cli/                    # CLI application (cac-based, 6 commands)
│       ├── src/
│       │   ├── index.ts        # Main entry point
│       │   ├── daemon.ts       # Background daemon runtime
│       │   └── commands/       # CLI subcommands
│       └── CHANGELOG.md
├── packages/
│   ├── core/                   # @the-brain-dev/core — types, hooks, plugin manager, db
│   ├── plugin-graph-memory/    # ⚡ Instant Layer — graph-based quick corrections
│   ├── plugin-spm-curator/     # ⚖️ Selection Layer — surprise-gated filtering
│   ├── plugin-harvester-cursor/# 📥 Cursor IDE log harvester
│   ├── plugin-harvester-claude/ # 📥 Claude Code log harvester
│   ├── plugin-identity-anchor/ # ⚓ Deep Layer — stable self-vector
│   ├── plugin-auto-wiki/       # 📚 Weekly static wiki output
│   ├── trainer-local-mlx/      # 💻 Local MLX LoRA training
│   └── python-sidecar/         # 🐍 Python MLX training script
├── scripts/
│   └── release.ts              # Release automation
├── AGENTS.md                   # This file
├── CONTRIBUTING.md
├── README.md
├── LICENSE
├── biome.json
└── install.sh
```

## Adding a New Plugin

1. Create `packages/plugin-<name>/` with a `package.json`
2. Create `src/index.ts` exporting `default definePlugin({ name, setup })`
3. Write tests in `src/__tests__/`
4. Add to `apps/cli/src/daemon.ts` plugin registration
5. Add CHANGELOG.md
6. Update root README.md package table

## Adding a New Harvester

See [HARVESTERS.md](HARVESTERS.md) for the full checklist (9 steps: plugin structure, interaction parsing, deduplication, project detection, hook registration, tests, daemon registration, documentation, code review).

## Branch Workflow

All work happens on feature branches. **Direct pushes to `main` are forbidden**
(enforced by GitHub branch protection). `main` contains only reviewed, merged, and tested code.

### GitHub Branch Protection

Branch protection is enforced via a GitHub Ruleset `main` (targeting `~DEFAULT_BRANCH`):

| Rule | Purpose |
|------|---------|
| `deletion` | Prevent deleting the `main` branch |
| `non_fast_forward` | Block force pushes (`git push -f`) |
| `update` | Block direct pushes to `main` (`git push origin main`) |
| `code_quality` | Require code quality checks (severity: errors) |
| `code_scanning` | Require CodeQL security scan (alerts: errors, security: high+) |
| `pull_request` | Require 1 approving review, stale reviews dismissed, last push approved, all threads resolved |

**CodeQL** runs on every PR and push to `main` via `.github/workflows/codeql.yml`.
It uses `security-extended` and `security-and-quality` query suites.
Weekly scheduled scan on Mondays at 08:00 UTC.

### Branch Naming

| Prefix | Purpose | Example |
|--------|---------|---------|
| `feat/` | New features, plugins, harvesters | `feat/harvester-gemini` |
| `fix/` | Bug fixes | `fix/double-evaluation-spm` |
| `refactor/` | Code restructuring (no behavior change) | `refactor/daemon-engine-separation` |
| `docs/` | Documentation only | `docs/api-reference-update` |
| `chore/` | CI, build, deps, tooling | `chore/update-bun` |
| `release/` | Release preparation (rare; release script handles this) | `release/v1.24.0` |

Branch names are **lowercase, hyphen-separated, max 50 chars**.

### Agent Workflow

When an AI coding agent (Cursor, Claude Code, Gemini CLI, Hermes, or the self-evolution harness)
works on the-brain, it follows this flow:

**Step 1 — Create branch:**
```bash
git checkout main
git pull origin main
git checkout -b <prefix>/<description>
```

**Step 2 — Work:** Make changes following AGENTS.md rules (tests, docs, changelog entries).

**Step 3 — Verify:**
```bash
bun test && bun run lint
```
Both must pass. Coverage ≥80% for new code.

**Step 4 — Commit:**
```bash
git status                     # See what you changed
git add <specific-files>       # ONLY files YOU modified this session
git commit -m "type(scope): description"
```
Use conventional commits. NEVER `git add -A` or `git add .`.

**Step 5 — Push:**
```bash
git push origin <branch-name>
```

**Step 6 — Create PR:** Open a pull request against `main` with:
- Concise title in conventional commit format
- Description: what, why, testing done, screenshots if UI change

**Step 7 — HITL Review:** A human reviews and merges.
- The agent MUST NOT merge its own PR
- After merge, delete the remote branch (GitHub PR settings can auto-delete)

### Multi-Session Branches

When an agent works on the same feature across multiple sessions:

```bash
# Session start — sync with main
git checkout <my-branch>
git pull origin main --rebase

# ... work, commit, push as usual ...
git push origin <my-branch>
```

**Before opening a PR:**
- Rebase on latest `main`: `git pull origin main --rebase`
- Resolve conflicts ONLY in files you authored
- If conflicts appear in files you didn't touch — **abort and ask the human**
- NEVER force push (`git push -f`)

### Forbidden Operations (any branch)

These can destroy work or bypass review:
- `git push origin main` — blocked by branch protection
- `git push --force` / `git push -f` — rewriting shared history
- `git reset --hard` — destroys uncommitted work
- `git checkout .` — destroys uncommitted work
- `git clean -fd` — deletes untracked files without review
- `git stash` / `git stash pop` — can clobber other agents' changes when used carelessly
- `git add -A` / `git add .` — sweeps up changes from other agents

### Commit Convention

```
type(scope?): concise description

Optional body with more details.
Footer: BREAKING CHANGE: description (if applicable)

Types: feat, fix, refactor, docs, chore, test, perf
Examples:
  feat(harvester): add Gemini CLI harvester plugin
  fix(spm): prevent double-evaluation during promote()
  refactor(daemon): separate engine init from infinite loop
  docs: update CLI reference with new --reprocess flag
  chore: bump Bun to 1.2.0
```

## Versioning

**Lockstep versioning**: All packages share the same version number. Bumping the root version bumps everything.

**Inter-package dependencies** use `workspace:*` in `dependencies` — Bun resolves these at link time, so cross-references never need manual version updates:
```json
{
  "dependencies": {
    "@the-brain-dev/core": "workspace:*"
  }
}
```

### Version Semantics

| Bump | When |
|------|------|
| `patch` | Bug fixes, new features (no API breaks), new harvesters, new plugins |
| `minor` | API breaking changes — plugin contracts, hook signatures, exported types, config schema |
| `major` | Fundamental architecture overhaul — core rewrite, storage migration, protocol change |

When in doubt: **patch**. Most changes are additive and non-breaking. Reserve minor for intentional contract changes.

### How to Bump

**During a release** — use the release script (handles everything):
```bash
bun run scripts/release.ts patch   # or minor, major, or exact x.y.z
```
This bumps root `package.json`, bumps all workspace packages to match, finalizes CHANGELOGs, commits, tags, publishes to npm, and adds fresh `[Unreleased]` sections.

**Manually (development / not releasing)** — use `npm version` with workspaces:
```bash
# Bump all packages from 0.1.0 to 0.2.0
npm version 0.2.0 --no-git-tag-version --workspaces
```
This updates every `package.json` in the workspace to the same version. No commit, no tag — you control when that happens.

**Manual single-package bump** — edit the `"version"` field in that package's `package.json` directly. Update `bun.lock` with `bun install` if needed.

### Version Consistency

All workspace packages MUST share the same version. After any manual bump, verify:
```bash
# Should print the same version for all packages
grep '"version"' packages/*/package.json apps/*/package.json package.json
```

## Releasing

### Release Steps

1. **Ensure `main` is clean**: All PRs merged, CI passing, no pending work
2. **Check CHANGELOGs**: Verify all changes since last release are documented under `[Unreleased]`
3. **Run release script**: `bun run scripts/release.ts patch|minor|major|<x.y.z>`
4. The script handles: version bump, targeted CHANGELOG finalization, commit, tag, npm publish, new `[Unreleased]` sections, and push to `main`

**Note:** The release script pushes directly to `main`. This requires admin access to bypass branch protection, or a temporary rule exemption. The script uses targeted `git add` (only `package.json` files, `bun.lock`, and changelogs) — it never uses `git add .`.

### Post-Release

- Verify the tag exists on GitHub: https://github.com/the-brain-dev/Brain/tags
- Verify the docs site rebuilds successfully (Cloudflare Pages auto-deploys from `main`)

## User override

If the user instructions conflict with rules set out here, ask for confirmation that they want
to override the rules. Only then execute their instructions.
