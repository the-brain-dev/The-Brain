# Contributing to the-brain (Archived)

This guide is retained as a historical record of the project's contribution process.

> **DEPRECATED — PROJECT ARCHIVED.** the-brain is no longer maintained. New contributions and support are not expected.

## Code of Conduct

We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they
interact with the rest of the system, a maintainer will ask for clarification before merging.

Using AI to write code is fine. Submitting AI-generated code without understanding it is not.

If you use an agent, run it from the `the-brain` root directory so it picks up `AGENTS.md`
automatically. Your agent must follow the rules and guidelines in that file.

## Historical Communication Channels

The archived repository retains its former [GitHub Issues](https://github.com/the-brain-dev/Brain/issues), [GitHub Discussions](https://github.com/the-brain-dev/Brain/discussions), and security-contact references for historical context. They are not monitored as a supported service.

## Historical Contribution Gate

First-time contributors started by opening an **Issue or Discussion** (not a PR).
This let maintainers scope the work before contributors invested time.

Approval happens through maintainer replies:

- `lgtmi`: your future issues will not require re-approval
- `lgtm`: your future issues and PRs will not require re-approval

Once a contributor received `lgtm`, they could submit PRs directly. Until then, the former process required an issue first.

## Quality Bar for Issues

- Keep it concise. If it doesn't fit on one screen, it's too long.
- Write in your own voice.
- State the bug or request clearly.
- Explain why it matters.
- If you want to implement the change yourself, say so.

## Historical Development Environment

The source repository remains available for inspection and forking. The former local setup and installation workflow is not supported.

**Verify:**

```bash
the-brain --version
bun test          # 940+ tests, 0 failures
bun run lint      # zero errors
```

## Historical Development Workflow

The project used the **fork-and-PR** model. Direct pushes to `main` were blocked.

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

## Historical PR Checklist

The former process required `lgtm` approval before opening a PR (see Historical Contribution Gate above).

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

### Why was there a contribution gate?

the-brain was maintained by a small team. The gate ensured every PR had been discussed and
scoped before code was written.

### How was a harvester added?

See [HARVESTERS.md](HARVESTERS.md) for the 9-step checklist: plugin structure, parsing,
deduplication, hook registration, testing, and daemon wiring.

### What counts as "core bloat"?

If it's a new memory layer, data source, or training backend, it should be a plugin.
If it's a fix to the plugin system, hook infrastructure, or data pipeline, it belongs in core.
The former process recommended opening a Discussion first when in doubt.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
