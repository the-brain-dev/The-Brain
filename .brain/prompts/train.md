---
description: Trigger LoRA training from curated deep-layer memories
argument-hint: "[--force] [--model <path>] [--iterations <n>]"
---
Train a LoRA adapter from deep-layer memory fragments.

Additional options: $ARGUMENTS

## Process

1. **Check prerequisites**:
   - Python 3.11+ with `uv` installed
   - `mlx-lm` package available in `packages/python-sidecar/`
   - At least 5 deep-layer memory fragments (unless `--force`)
   - Model checkpoint available at `mlx.modelPath` (default: `mlx-community/SmolLM2-135M-Instruct`)

2. **Prepare training data**:
   - Load all `deep` layer memories from current context's DB
   - Format each as: `{"prompt": "Remember: ...", "completion": "<memory content>"}`
   - Write to `lora_fragments.json` in `mlx.loraOutputDir`
   - Minimum 10 fragments for effective training (warning if fewer)

3. **Run MLX training**:
   ```bash
   cd packages/python-sidecar
   uv run python run_lora.py \
     --model <model_path> \
     --data lora_fragments.json \
     --iters <n> \
     --output <output_dir>/adapter.safetensors
   ```
   - Default: 50 iterations
   - Freeze base model, unfreeze only `lora_a` and `lora_b` keys
   - AdamW optimizer

4. **Verify output**:
   - Check `adapter.safetensors` exists (expected: ~2.5 MB, 56 params)
   - Check `training_config.json` exists
   - Verify loss decreased (should be <1.0 after 50 iters)

5. **Update daemon state**:
   - Record last training timestamp
   - Store adapter path for `beforePrompt` injection

## Output Format

```
MLX LoRA Training
Model: <model>
Fragments: <N>
Iterations: <N>
Iter <N>: Train loss <X.XXX>
...
Iter <N>: Train loss <X.XXX>
Saved to: <path>/adapter.safetensors (<SIZE> MB)
Duration: <DURATION>s
```

## Hooks Fired

- `training:start`
- `training:complete` (on success)
- `training:error` (on failure)

## Error Handling

- If `uv` not found: suggest `curl -LsSf https://astral.sh/uv/install.sh | sh`
- If model not cached: download via `mlx-lm` first
- If training fails: emit `training:error`, save error log, retry interval doubles
- If insufficient fragments: skip, log info
