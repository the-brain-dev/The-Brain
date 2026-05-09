# Contributing to the-brain

This guide exists to save both sides time.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they
interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated code without understanding it is not.

If you use an agent, run it from the `the-brain` root directory so it picks up `AGENTS.md`
automatically. Your agent must follow the rules and guidelines in that file.

## Contribution Gate

All issues and PRs from new contributors are auto-closed by default.

Maintainers review auto-closed issues daily and reopen worthwhile ones. Issues that do not
meet the quality bar below will not be reopened or receive a reply.

Approval happens through maintainer replies on issues:

- `lgtmi`: your future issues will not be auto-closed
- `lgtm`: your future issues and PRs will not be auto-closed

`lgtmi` does not grant rights to submit PRs. Only `lgtm` grants rights to submit PRs.

## Quality Bar For Issues

- Keep it concise. If it does not fit on one screen, it is too long.
- Write in your own voice.
- State the bug or request clearly.
- Explain why it matters.
- If you want to implement the change yourself, say so.

If the issue is real and written well, a maintainer may reopen it, reply `lgtmi`, or reply `lgtm`.

## Blocking

If you ignore this document twice, or if you spam the tracker with agent-generated issues,
your GitHub account will be permanently blocked.

## Branch Workflow

All work happens on feature branches. **Direct pushes to `main` are forbidden.**

1. Create a branch: `feat/`, `fix/`, `refactor/`, `docs/`, or `chore/` prefix
2. Work, test, commit
3. Push and open a PR against `main`
4. Maintainer reviews and merges

See [AGENTS.md](AGENTS.md) for full branch naming rules, agent workflow, and commit conventions.

## Before Submitting a PR

Do not open a PR unless you have already been approved with `lgtm`.

Before submitting a PR:

```bash
bun test --coverage
bun run lint
```

Both must pass. Target >80% line coverage for new code.

Do not edit `CHANGELOG.md`. Changelog entries are added by maintainers during release.

## Philosophy

the-brain's core is minimal. If your feature does not belong in the core, it should be a plugin.
PRs that bloat the core will likely be rejected.

## Questions?

Open a discussion on [GitHub Discussions](https://github.com/the-brain-dev/Brain/discussions).

## FAQ

### Why are new issues and PRs auto-closed?

the-brain receives more contributions than maintainers can responsibly review in real time.
Auto-closing creates a buffer so maintainers can review the tracker on their own schedule
and reopen the issues that meet the quality bar.

### Is this hostile to contributors?

No. It is a guardrail against burnout and tracker spam. Short, concrete, reproducible issues
are welcome. Thoughtful contributions are welcome. Automated slop, entitlement, and large
volumes of low-effort reports are not.
