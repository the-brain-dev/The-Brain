---
description: Run memory consolidation — SPM evaluation + promotion to Deep Layer
argument-hint: "[--reprocess] [--project <name>]"
---
Consolidate memories through the my-brain cognitive pipeline.

Additional options: $ARGUMENTS

## Process

1. **Determine target**: If `--project <name>` is provided, consolidate only that project's DB.
   Otherwise, consolidate the global brain at `~/.my-brain/global/brain.db`.

2. **Load project isolation**: Use `ProjectManager.resolveDB()` to find the correct database.
   If `--reprocess` is given, re-process ALL instant-layer memories through SPM (not just new ones).

3. **SPM Evaluation** (Selection Layer):
   - Load all memories in `instant` layer from target DB
   - For each memory, compute `surpriseScore` using the Surprise-Gated SPM algorithm
   - If `surpriseScore >= threshold` (default 0.3): promote to `selection` layer
   - Otherwise: keep in `instant` (will be garbage-collected later)

4. **Deep Promotion** (Selection → Deep):
   - Load all `selection` layer memories
   - For each: if `surpriseScore >= threshold`, promote to `deep` layer
   - Track: `fragmentsPromoted`, `fragmentsDiscarded`

5. **Cross-Project Promotion**:
   - If a pattern hash appears in ≥2 different project contexts
   - Promote to global `brain.db` as a universal memory

6. **Wiki Generation** (if `wiki.enabled: true`):
   - Generate Karpathy-style wiki pages from `deep` layer memories
   - Format: Markdown with YAML frontmatter, `[[wikilinks]]`, timestamp
   - Output: `~/.my-brain/global/wiki/` (global) or `projects/<name>/wiki/`

7. **MLX Trigger** (if `mlx.enabled: true`):
   - If ≥10 new deep memories since last training
   - Generate `lora_fragments.json`
   - Trigger `python-sidecar/run_lora.py`

## Output Format

```
SPM reprocessing: <N>/<TOTAL> scored
Consolidation: <PROMOTED> surprising (≥<THRESHOLD>) → DEEP
Cross-project promotions: <N>
Total: <TOTAL> memories (<instant> instant + <selection> selection + <deep> deep)
Wiki: <N> pages generated
Duration: <DURATION>ms
```

## Hooks Fired

- `consolidate:start`
- `selection:evaluate` (per memory)
- `selection:promote` (per promoted)
- `deep:consolidate` (per layer)
- `consolidate:complete`

## Error Handling

- If DB is locked: queue retry for next daemon cycle
- If SPM evaluation fails: log error, continue with remaining memories
- If wiki generation fails: log error, do not block consolidation
- If MLX training fails: emit `training:error`, continue
