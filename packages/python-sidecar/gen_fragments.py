#!/usr/bin/env python3
"""Generate LoRA training fragments as JSON file."""
import json
import os
import sys


fragments = [
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
        "text": "When fixing a bug, write a regression test first (RED phase). Only after confirming the test fails should you fix the code (GREEN phase). Then refactor.",
        "metadata": {"source": "claude", "layer": "instant", "type": "correction", "weight": 0.9}
    },
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
        "text": "Maintain >80% line coverage across all packages. Use bun test --coverage to verify. Mock filesystem by overriding process.env.HOME to an isolated temp directory — never use mock.module().",
        "metadata": {"source": "claude", "layer": "instant", "type": "correction", "weight": 0.9}
    },
    {
        "text": "No `any` types unless absolutely necessary — document the reason with a comment. Always prefer generics or utility types. Use Zod for runtime validation.",
        "metadata": {"source": "claude", "layer": "instant", "type": "correction", "weight": 0.9}
    },
    {
        "text": "All code, comments, and documentation in English. Only user-facing CLI messages in Polish. Commit messages follow conventional commits: feat, fix, chore, docs, refactor, test.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.8}
    },
    {
        "text": "Graph memory deduplication: Pattern nodes are identified by SHA-256 hash of normalized text + significant properties. When a matching pattern exists, boost its weight by 0.1 instead of creating a new node.",
        "metadata": {"source": "claude", "layer": "instant", "type": "correction", "weight": 1.0}
    },
    {
        "text": "Communication with the user in Polish. Keep answers short and concise. No emojis in commits, issues, PR comments, or code (except README branding). Technical prose only.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.8}
    },
    {
        "text": "No docstrings on every function, no JSDoc for obvious parameters. The code itself should be the documentation. Use self-documenting patterns.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.7}
    },
    {
        "text": "The LLM Wiki lives at ~/wiki/ and follows Karpathy's format. Sections: AI/ML research, projects, HeyCoco, private. Before each session, read SCHEMA.md, index.md, and recent logs.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.7}
    },
    {
        "text": "CPV (Context Preference Vectors) research is about capturing user preferences at token-level via contrastive pairs. SPM (Self-Predictive Memory) is about using a model's own predictions as memory signals.",
        "metadata": {"source": "claude", "layer": "deep", "type": "preference", "weight": 0.9}
    },
]

output_path = os.path.expanduser("~/.the-brain/lora-checkpoints/lora_fragments.json")
if len(sys.argv) > 1:
    output_path = sys.argv[1]

try:
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
except OSError as e:
    print(f"ERROR: Cannot create output directory: {e}", file=sys.stderr)
    sys.exit(1)

try:
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(fragments, f)
except (OSError, json.JSONEncodeError) as e:
    print(f"ERROR: Failed to write fragments: {e}", file=sys.stderr)
    sys.exit(1)

print(f"Written {len(fragments)} fragments to {output_path}")
