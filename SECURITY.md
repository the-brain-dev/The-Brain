# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in my-brain, please **do not** open a public issue.

Instead, email the maintainers privately at:

**security <at> my-brain.dev**

We will respond within 48 hours and work with you to resolve the issue.

## Scope

my-brain handles sensitive data:

- IDE interaction logs (Cursor, Claude Code, Windsurf, Copilot)
- Code context and edit history
- Personal coding patterns and preferences
- Local model training data

All data is designed to stay **local-first** by default. We take this commitment seriously.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x   | :white_check_mark: |

## Best Practices

- All data is stored locally in `~/.my-brain/` by default
- No telemetry or cloud uploads unless explicitly configured
- MLX training data (`.safetensors` files) stays on your machine
- Use environment variables for API keys, never commit them

## Third-Party Plugins

Community plugins may introduce their own data handling. Review a plugin's source code
before installing it. Plugins that send data off-machine should clearly state this in their
README.
