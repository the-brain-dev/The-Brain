# Contributing to the-brain

Thanks for your interest in contributing. This guide keeps things efficient for both sides.

## Code of Conduct

We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they
interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated code without understanding it is not.

If you use an agent, run it from the `the-brain` root directory so it picks up `AGENTS.md`
automatically. Your agent must follow the rules and guidelines in that file.

## Communication

- **Bug reports & feature requests:** [GitHub Issues](https://github.com/the-brain-dev/Brain/issues)
- **Questions & discussion:** [GitHub Discussions](https://github.com/the-brain-dev/Brain/discussions)
- **Security issues:** Email maintainers directly (see [README](README.md) for contact)

## Contribution Gate

First-time contributors start by opening an **Issue or Discussion** (not a PR).
This lets maintainers scope the work before you invest time.

Approval happens through maintainer replies:

- `lgtmi`: your future issues will not require re-approval
- `lgtm`: your future issues and PRs will not require re-approval

Once you receive `lgtm`, you can submit PRs directly. Until then, open an issue first.

## Quality Bar for Issues

- Keep it concise. If it doesn't fit on one screen, it's too long.
- Write in your own voice.
- State the bug or request clearly.
- Explain why it matters.
- If you want to implement the change yourself, say so.

## Development Environment

**Prerequisites:**

- [Bun](https://bun.sh) ≥ 1.0 (runtime, package manager, test runner)
- [uv](https://docs.astral.sh/uv/) (Python sidecar for MLX training, macOS only)
- macOS with Apple Silicon for MLX features (optional — core works on any platform)

**Setup:**

```bash
git clone https://github.com/<your-username>/Brain.git  # your fork
cd Brain
git remote add upstream https://github.com/the-brain-dev/Brain.git
./install.sh
```

**Verify:**

```bash
the-brain --version
bun test          # 940+ tests, 0 failures
bun run lint      # zero errors
```

## Development Workflow

We use the **fork-and-PR** model. Direct pushes to `main` are blocked.

```bash
# 1. Sync with upstream
git fetch upstream
git checkout -b feat/your-feature upstream/main

# 2. Write code, following AGENTS.md conventions

# 3. Test and lint
bun test --coverage
bun run lint

# 4. Commit (conventional commits)
git add <specific-files>       # targeted add only — never git add -A or .
git commit -m "type(scope): description"

# 5. Push to your fork
git push origin feat/your-feature

# 6. Open a PR against the-brain-dev/Brain:main
```

Branch naming: lowercase, hyphen-separated, max 50 chars. Prefixes: `feat/`, `fix/`, `refactor/`, `docs/`, `chore/`.

See [AGENTS.md](AGENTS.md) for full coding standards, commit conventions, and agent workflow.

## Before Submitting a PR

Do not open a PR unless you've been approved with `lgtm` (see Contribution Gate above).

```bash
bun test --coverage     # >80% line coverage for new code
bun run lint            # zero errors
cd apps/docs && bun run build  # docs compile clean
```

Update the relevant `packages/*/CHANGELOG.md` under `## [Unreleased]` with your changes.
See [AGENTS.md](AGENTS.md#changelog) for the exact format.

## Philosophy

the-brain's core is minimal. If your feature doesn't belong in the core, it should be a plugin.
PRs that bloat the core will likely be rejected.

Read [PHILOSOPHY.md](PHILOSOPHY.md) for the full vision.

## FAQ

### Why the contribution gate?

the-brain is maintained by a small team. The gate ensures every PR has been discussed and
scoped before code is written — saving both your time and ours.

### How do I add a harvester?

See [HARVESTERS.md](HARVESTERS.md) for the 9-step checklist: plugin structure, parsing,
deduplication, hook registration, testing, and daemon wiring.

### What counts as "core bloat"?

If it's a new memory layer, data source, or training backend, it should be a plugin.
If it's a fix to the plugin system, hook infrastructure, or data pipeline, it belongs in core.
When in doubt, open a Discussion first.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
