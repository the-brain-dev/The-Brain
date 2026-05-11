#!/usr/bin/env python3
"""Generate meaningful LoRA training data from real user interactions."""
import json

fragments = [
    # ——— TypeScript / Coding Preferences ———
    {
        "text": "Always use top-level imports. No `await import('./foo.js')`, no `import('pkg').Type` in type positions. Never remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead.",
        "metadata": {"source": "claude", "layer": "instant", "type": "correction", "weight": 1.0}
    },
    {
        "text": "Prefer absolute paths from project root (e.g. @/components/) over relative imports. Avoid default exports — use named exports for better tree-shaking and IDE support.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.8}
    },
    {
        "text": "Use Bun for all TS/JS tooling: bun test for tests, bun run for scripts, bun x for one-offs. Never use npx or tsx alongside Bun.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.9}
    },
    {
        "text": "Write production code not boilerplate. No docstrings on every function, no JSDoc for obvious parameters. The code itself should be the documentation. Use self-documenting patterns.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.7}
    },
    {
        "text": "When fixing a bug, write a regression test first (RED phase). Only after confirming the test fails should you fix the code (GREEN phase). Then refactor.",
        "metadata": {"source": "claude", "layer": "instant", "type": "correction", "weight": 0.9}
    },
    # ——— Architecture & Design ———
    {
        "text": "the-brain follows a plugin architecture. The core is an empty data bus. Everything — harvesters, memory modules, trainers — must be swappable plugins via definePlugin(). Never hardcode a memory implementation.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 1.0}
    },
    {
        "text": "Local-First means data never leaves the user's machine. Use SQLite for persistence, MLX for training, Ollama/LM Studio for inference. Never call cloud APIs unless the user explicitly installed a cloud plugin.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 1.0}
    },
    {
        "text": "Selection over accumulation: Don't store everything. Use Surprise-Gated SPM to filter out redundant, low-value information. The system must actively reject noise.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.9}
    },
    {
        "text": "Ambient UX: The best tools run in the background. the-brain daemon should collect data with zero manual effort from the user. Never ask for confirmation for routine collection.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.8}
    },
    # ——— Testing Patterns ———
    {
        "text": "Maintain >80% line coverage across all packages. Use bun test --coverage to verify. Mock filesystem by overriding process.env.HOME to an isolated temp directory — never use mock.module().",
        "metadata": {"source": "claude", "layer": "instant", "type": "correction", "weight": 0.9}
    },
    {
        "text": "Tests live in src/__tests__/ next to the code they test. Integration tests use real filesystem paths but under isolated temp dirs. Do not use real API keys or paid tokens in tests.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.8}
    },
    # ———— Code Quality ———
    {
        "text": "No `any` types unless absolutely necessary — document the reason with a comment. Always prefer generics or utility types. Use Zod for runtime validation.",
        "metadata": {"source": "claude", "layer": "instant", "type": "correction", "weight": 0.9}
    },
    {
        "text": "Use Biome for linting and formatting. Never use Prettier or ESLint. Format on save. Run biome check before commits.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.7}
    },
    {
        "text": "All code, comments, and documentation in English. Only user-facing CLI messages in Polish. Commit messages follow conventional commits: feat, fix, chore, docs, refactor, test.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.8}
    },
    # ——— Graph Memory Patterns ———
    {
        "text": "Graph memory deduplication: Pattern nodes are identified by SHA-256 hash of normalized text + significant properties. When a matching pattern exists, boost its weight by 0.1 instead of creating a new node.",
        "metadata": {"source": "claude", "layer": "instant", "type": "correction", "weight": 1.0}
    },
    {
        "text": "Graph node weights decay over time. Weight decreases by log(1 + hours_since_last_seen) * 0.05. Nodes below 0.1 threshold are pruned during consolidation.",
        "metadata": {"source": "claude", "layer": "instant", "type": "correction", "weight": 0.7}
    },
    # ——— Project-specific ———
    {
        "text": "CPV (Context Preference Vectors) research is about capturing user preferences at token-level via contrastive pairs. SPM (Self-Predictive Memory) is about using a model's own predictions as memory signals. Both are memory tracks.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.9}
    },
    {
        "text": "The LLM Wiki lives at ~/wiki/ and follows Karpathy's format. Sections: AI/ML research, projects, HeyCoco, private. Before each session, read SCHEMA.md, index.md, and recent logs.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.7}
    },
    # ——— Communication ———
    {
        "text": "Communication with the user in Polish. Keep answers short and concise. No emojis in commits, issues, PR comments, or code (except README branding). Technical prose only.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.8}
    },
    {
        "text": "When asked for planning, structure into logical tasks with estimated effort. Use TODO lists for tracking. Mark tasks completed immediately when done.",
        "metadata": {"source": "claude", "layer": "instant", "type": "correction", "weight": 0.6}
    },
]


def main():
    output = json.dumps(fragments)
    print(f"Generated {len(fragments)} training fragments")
    print(f"JSON size: {len(output)} chars")
    print()
    print(output)


if __name__ == "__main__":
    main()
